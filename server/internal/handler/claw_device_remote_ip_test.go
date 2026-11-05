package handler

// 设备「公网 IP」字段（迁移 610）：来源地址由**服务端观测**，不是设备自述。
//
// 两条测试分开写：
//   - clawDeviceObservedIP / clawIPIsPublic 是纯函数，表驱动覆盖拓扑差异（直连
//     公网、本机反代、同内网直连）与伪造头；
//   - 落库那条走真库（testPool），钉住「每轮轮询都会刷新 remote_ip_at」与
//     「空 IP 不写行」两个写入语义。

import (
	"context"
	"net"
	"net/http"
	"testing"
	"time"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestClawDeviceObservedIP(t *testing.T) {
	cases := []struct {
		name   string
		remote string
		realIP string
		xff    string
		want   string
	}{
		{
			name:   "直连公网：RemoteAddr 即答案",
			remote: "203.0.113.9:51234",
			want:   "203.0.113.9",
		},
		{
			// 直连拓扑下设备自己就能塞转发头；信了等于让它自报 IP，而详情页要的
			// 恰恰是「服务端眼里你是谁」。
			name:   "直连公网：忽略设备伪造的 XFF",
			remote: "203.0.113.9:51234",
			xff:    "1.2.3.4",
			want:   "203.0.113.9",
		},
		{
			name:   "直连公网：忽略设备伪造的 X-Real-IP",
			remote: "203.0.113.9:51234",
			realIP: "1.2.3.4",
			want:   "203.0.113.9",
		},
		{
			// 生产就是这形态：nginx 与本服务同机，RemoteAddr 恒为 127.0.0.1。
			name:   "本机反代：取 X-Real-IP",
			remote: "127.0.0.1:41234",
			realIP: "198.51.100.7",
			xff:    "198.51.100.7",
			want:   "198.51.100.7",
		},
		{
			// XFF 是「客户端, 代理1, 代理2」的链，最左边那跳才是原始客户端。
			name:   "本机反代：XFF 取最左一跳",
			remote: "127.0.0.1:41234",
			xff:    "198.51.100.7, 10.0.0.1, 127.0.0.1",
			want:   "198.51.100.7",
		},
		{
			name:   "本机反代：X-Real-IP 优先于 XFF",
			remote: "127.0.0.1:41234",
			realIP: "198.51.100.7",
			xff:    "192.0.2.44",
			want:   "198.51.100.7",
		},
		{
			// 设备与服务端同处内网：服务端看到的就是内网地址，如实存下来，
			// 由 remote_ip_public 告诉 UI 打「内网」标记。
			name:   "同内网直连：保留内网地址",
			remote: "10.1.1.225:51000",
			want:   "10.1.1.225",
		},
		{
			name:   "RemoteAddr 没有端口",
			remote: "203.0.113.9",
			want:   "203.0.113.9",
		},
		{
			name:   "IPv6 公网",
			remote: "[2001:db8::1]:51000",
			want:   "2001:db8::1",
		},
		{
			name:   "空 RemoteAddr 且无头：返回空串（调用方跳过写入）",
			remote: "",
			want:   "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := &http.Request{RemoteAddr: tc.remote, Header: http.Header{}}
			if tc.realIP != "" {
				r.Header.Set("X-Real-IP", tc.realIP)
			}
			if tc.xff != "" {
				r.Header.Set("X-Forwarded-For", tc.xff)
			}
			if got := clawDeviceObservedIP(r); got != tc.want {
				t.Fatalf("clawDeviceObservedIP() = %q, want %q", got, tc.want)
			}
		})
	}

	if got := clawDeviceObservedIP(nil); got != "" {
		t.Fatalf("clawDeviceObservedIP(nil) = %q, want empty", got)
	}
}

func TestClawIPIsPublic(t *testing.T) {
	cases := map[string]bool{
		"203.0.113.9":   true,
		"8.8.8.8":       true,
		"2001:db8::1":   true,
		"10.1.1.225":    false,
		"172.16.3.4":    false,
		"192.168.1.10":  false,
		"127.0.0.1":     false,
		"169.254.1.1":   false,
		"0.0.0.0":       false,
		"100.64.1.1":    false, // CGNAT：公网不可路由，不能当公网 IP 展示
		"100.127.255.1": false,
		"100.128.0.1":   true, // 出 CGNAT 段就按公网算
		"::1":           false,
		"fe80::1":       false,
	}
	for raw, want := range cases {
		if got := clawIPIsPublic(net.ParseIP(raw)); got != want {
			t.Fatalf("clawIPIsPublic(%s) = %v, want %v", raw, got, want)
		}
	}
	if clawIPIsPublic(nil) {
		t.Fatal("clawIPIsPublic(nil) must be false")
	}
}

// TestClawDeviceRecordRemoteIP 钉住写入语义：同一台机器连续两轮轮询分别来自不同
// 地址时，列值必须跟着走；remote_ip_at 每轮都刷新（它是「最近一次确认」，不是
// 「第一次出现」）；空地址不建行（否则每台从没连过的机器都会多一条空行）。
func TestClawDeviceRecordRemoteIP(t *testing.T) {
	if testPool == nil || testHandler == nil {
		t.Skip("handler test database is not available")
	}
	ctx := context.Background()
	machine := clawUpgradeTestMachine("upgrade-remoteip")
	rc := "rc_node_" + machine
	cleanupClawUpgradeTestRows(t, []string{machine}, []string{rc})
	insertClawUpgradeTestNode(t, testWorkspaceID, machine, rc)

	var node db.RongcloudNode
	if err := testPool.QueryRow(ctx, `
		SELECT id, workspace_id, rongcloud_user_id, machine_id
		  FROM rongcloud_node WHERE machine_id = $1`, machine).
		Scan(&node.ID, &node.WorkspaceID, &node.RongcloudUserID, &node.MachineID); err != nil {
		t.Fatalf("load node: %v", err)
	}

	// 空 IP：不写行。没连过的机器不该因为一次解析失败多出一条空记录。
	if err := testHandler.clawDeviceRecordRemoteIP(ctx, node, ""); err != nil {
		t.Fatalf("record empty ip: %v", err)
	}
	if _, found, err := testHandler.clawNodeUpgradeByMachine(ctx, machine); err != nil {
		t.Fatalf("read after empty ip: %v", err)
	} else if found {
		t.Fatal("an empty observed ip must not materialise an upgrade row")
	}

	// 第一轮轮询。
	if err := testHandler.clawDeviceRecordRemoteIP(ctx, node, "203.0.113.9"); err != nil {
		t.Fatalf("record first ip: %v", err)
	}
	first, found, err := testHandler.clawNodeUpgradeByMachine(ctx, machine)
	if err != nil || !found {
		t.Fatalf("read row after first ip: found=%v err=%v", found, err)
	}
	if first.RemoteIP != "203.0.113.9" {
		t.Fatalf("remote_ip = %q, want 203.0.113.9", first.RemoteIP)
	}
	if !first.RemoteIPAt.Valid {
		t.Fatal("remote_ip_at must be stamped on the first observation")
	}
	// IP 写入不该动 updated_at：那一列是管理端排序/判活的口径。
	if age := time.Since(first.UpdatedAt); age > time.Minute {
		t.Fatalf("recording a remote ip must not touch updated_at (still %s old)", age)
	}

	// 把 remote_ip_at 拨回 30 分钟前，验证下一轮确实把它刷到「刚刚」，而不是
	// 只在 IP 变化时才写。
	if _, err := testPool.Exec(ctx, `
		UPDATE rongcloud_node_upgrade
		   SET remote_ip_at = now() - interval '30 minutes'
		 WHERE machine_id = $1`, machine); err != nil {
		t.Fatalf("backdate remote_ip_at: %v", err)
	}
	if err := testHandler.clawDeviceRecordRemoteIP(ctx, node, "203.0.113.9"); err != nil {
		t.Fatalf("record same ip again: %v", err)
	}
	again, _, err := testHandler.clawNodeUpgradeByMachine(ctx, machine)
	if err != nil {
		t.Fatalf("read row after second observation: %v", err)
	}
	if !again.RemoteIPAt.Valid {
		t.Fatal("remote_ip_at must stay valid")
	}
	if age := time.Since(again.RemoteIPAt.Time); age > time.Minute {
		t.Fatalf("remote_ip_at must refresh on every poll, still %s old", age)
	}

	// 换网/重拨号：地址跟着走。
	if err := testHandler.clawDeviceRecordRemoteIP(ctx, node, "198.51.100.7"); err != nil {
		t.Fatalf("record moved ip: %v", err)
	}
	moved, _, err := testHandler.clawNodeUpgradeByMachine(ctx, machine)
	if err != nil {
		t.Fatalf("read row after move: %v", err)
	}
	if moved.RemoteIP != "198.51.100.7" {
		t.Fatalf("a new observed ip must replace the stored one, got %q", moved.RemoteIP)
	}
	// 版本上报那一路的列不能被 IP 写入擦掉：两者共用一行，但各写各的列。
	if err := testHandler.clawDeviceRecordUpgradeState(ctx, node,
		"1.3.21", clawUpgradePlatformWindows, "host-ip", "", 0); err != nil {
		t.Fatalf("version upsert: %v", err)
	}
	if err := testHandler.clawDeviceRecordRemoteIP(ctx, node, "198.51.100.7"); err != nil {
		t.Fatalf("record ip after version: %v", err)
	}
	merged, _, err := testHandler.clawNodeUpgradeByMachine(ctx, machine)
	if err != nil {
		t.Fatalf("read merged row: %v", err)
	}
	if merged.ReportedVersion != "1.3.21" || merged.ReportedHostname != "host-ip" {
		t.Fatalf("remote-ip writes must not clobber version columns (version=%q hostname=%q)",
			merged.ReportedVersion, merged.ReportedHostname)
	}
	if merged.RemoteIP != "198.51.100.7" {
		t.Fatalf("version writes must not clobber remote_ip, got %q", merged.RemoteIP)
	}
}
