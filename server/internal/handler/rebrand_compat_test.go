package handler

// 品牌改名（clawmessenger -> agentsbb）过渡期的兼容契约测试。
//
// 改名期要同时成立三件事，任何一件破了都是线上事故：
//  1. Release 里有**两套**资产名（agentsbb-* 与 clawmessenger-*，字节相同）；
//  2. 服务端下发给设备的是**新名**（设备照 intent.assetName 下载，不会 404）；
//  3. 下载代理的白名单与 tag 前缀**新旧都认**（老设备手工 `agentsbb update`
//     会按旧清单拼地址；镜像里还挂着改名前的 1.3.x）。
//
// 这些断言是给「删旧名单」那一刻用的：v1.6.0 垫片退役时本文件里的 legacy 用例
// 会一起红，提醒实施者按 TODO(rebrand-retire) 收尾，而不是漏删一半。

import (
	"strings"
	"testing"
)

func TestClawUpgradeVersionFromTagAcceptsBothPrefixes(t *testing.T) {
	cases := []struct {
		tag  string
		want string
	}{
		{"agentsbb-v1.4.0", "1.4.0"},
		{"clawmessenger-v1.3.33", "1.3.33"},
		{"agentsbb-v0.0.1", "0.0.1"},
		{"1.4.0", "1.4.0"},
		{"agentsbb-v11.22.33", "11.22.33"},
	}
	for _, tc := range cases {
		if got := clawUpgradeVersionFromTag(tc.tag); got != tc.want {
			t.Fatalf("clawUpgradeVersionFromTag(%q) = %q, want %q", tc.tag, got, tc.want)
		}
	}
}

func TestClawUpgradeTagFromVersionUsesNewPrefix(t *testing.T) {
	for _, version := range []string{"1.4.0", "v1.4.0"} {
		if got := clawUpgradeTagFromVersion(version); got != "agentsbb-v1.4.0" {
			t.Fatalf("clawUpgradeTagFromVersion(%q) = %q", version, got)
		}
	}
	// 与 clawUpgradeTagForVersion 必须是同一个值：历史调用点还走那个名字。
	if clawUpgradeTagForVersion("1.4.0") != clawUpgradeTagFromVersion("1.4.0") {
		t.Fatal("clawUpgradeTagForVersion 与 clawUpgradeTagFromVersion 不一致")
	}
}

func TestClawUpgradeTagCandidatesPrefersNewPrefix(t *testing.T) {
	got := clawUpgradeTagCandidates("1.4.0")
	want := []string{"agentsbb-v1.4.0", "clawmessenger-v1.4.0"}
	if len(got) != len(want) {
		t.Fatalf("candidates = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("candidates[%d] = %q, want %q（新前缀必须排在前面）", i, got[i], want[i])
		}
	}
}

func TestClawUpgradeAssetSupportedAcceptsBothNames(t *testing.T) {
	supported := []string{
		"agentsbb-windows-x64.exe",
		"agentsbb-linux-x64",
		"agentsbb-linux-arm64",
		"agentsbb-darwin-arm64",
		// 旧名单：下载代理的白名单过渡期必须放行，否则老设备手工更新会 400。
		"clawmessenger-windows-x64.exe",
		"clawmessenger-linux-x64",
		"clawmessenger-linux-arm64",
		"clawmessenger-darwin-arm64",
	}
	for _, asset := range supported {
		if !clawUpgradeAssetSupported(asset) {
			t.Fatalf("%s 应被下载代理接受", asset)
		}
	}
	// 白名单之外的仍然是拒绝：改名不该顺手把这道门开大。
	for _, asset := range []string{
		"",
		"agentsbb.exe",
		"clawmessenger.exe",
		"agentsbb-linux-riscv64",
		"clawmessenger-linux-riscv64",
		"SHA256SUMS",
		"../agentsbb-windows-x64.exe",
	} {
		if clawUpgradeAssetSupported(asset) {
			t.Fatalf("%q 不该被下载代理接受", asset)
		}
	}
}

func TestClawUpgradeAssetMapUsesNewNames(t *testing.T) {
	// 服务端下发给设备的资产名（intent.assetName）必须是新名 —— 设备不自己挑名字，
	// 服务端说什么它下什么，所以这里切新名不会让存量设备 404。
	for platform, asset := range clawUpgradeAssetsByPlatform {
		if !strings.HasPrefix(asset, clawMirrorAssetPrefix) {
			t.Fatalf("平台 %s 的资产名 %q 应为 agentsbb-* 开头", platform, asset)
		}
	}
	// 旧名单必须与平台映射一一同形（少一个平台就是一条 400 的路）。
	if len(clawUpgradeLegacyAssets) != len(clawUpgradeAssetsByPlatform) {
		t.Fatalf("legacy 资产数 %d != 平台数 %d", len(clawUpgradeLegacyAssets), len(clawUpgradeAssetsByPlatform))
	}
	for platform, asset := range clawUpgradeAssetsByPlatform {
		legacy, ok := clawUpgradeLegacyAssets[platform]
		if !ok {
			t.Fatalf("平台 %s 缺旧名单条目", platform)
		}
		if want := clawMirrorLegacyName(asset); legacy != want {
			t.Fatalf("平台 %s 旧名 %q != %q", platform, legacy, want)
		}
	}
}

func TestClawMirrorLegacyAssetsMirrorRequiredAssets(t *testing.T) {
	// 旧名单由新名单机械派生：长度一致、逐项前缀替换、SHA256SUMS 不参与。
	if len(clawMirrorLegacyAssets) != len(clawMirrorRequiredAssets)-1 {
		t.Fatalf("legacy 条目 %d 个，want %d", len(clawMirrorLegacyAssets), len(clawMirrorRequiredAssets)-1)
	}
	for i, asset := range clawMirrorRequiredAssets {
		if asset == "SHA256SUMS" {
			continue
		}
		legacy := clawMirrorLegacyAssets[i]
		if !strings.HasPrefix(legacy, clawMirrorLegacyAssetPrefix) {
			t.Fatalf("%q 应以 %q 开头", legacy, clawMirrorLegacyAssetPrefix)
		}
		if got := clawMirrorLegacyName(legacy); got != "" {
			t.Fatalf("旧名 %q 不该再被映射一次，got %q", legacy, got)
		}
	}
	if got := clawMirrorLegacyName("SHA256SUMS"); got != "" {
		t.Fatalf("clawMirrorLegacyName(SHA256SUMS) = %q, want 空串", got)
	}
}

func TestClawMirrorPickAssetSet(t *testing.T) {
	toSet := func(names []string) map[string]bool {
		out := make(map[string]bool, len(names))
		for _, name := range names {
			out[name] = true
		}
		return out
	}

	// 只有新名：认新名单。
	chosen, other, ok := clawMirrorPickAssetSet(toSet(clawMirrorRequiredAssets))
	if !ok || chosen[0] != clawMirrorRequiredAssets[0] || other[0] != clawMirrorLegacyAssets[0] {
		t.Fatalf("新名整包：ok=%v chosen=%v other=%v", ok, chosen, other)
	}

	// 只有旧名（改名前的镜像包）：必须也能传上来，否则升级窗口内后台直接不可用。
	chosen, other, ok = clawMirrorPickAssetSet(toSet(clawMirrorLegacyAssets))
	if !ok || chosen[0] != clawMirrorLegacyAssets[0] || other[0] != clawMirrorRequiredAssets[0] {
		t.Fatalf("旧名整包：ok=%v chosen=%v other=%v", ok, chosen, other)
	}

	// 两套都在：按新名单严格核对。
	both := append(append([]string{}, clawMirrorRequiredAssets...), clawMirrorLegacyAssets...)
	chosen, _, ok = clawMirrorPickAssetSet(toSet(both))
	if !ok || chosen[0] != clawMirrorRequiredAssets[0] {
		t.Fatalf("双名整包应优先新名单：ok=%v chosen=%v", ok, chosen)
	}

	// 两套都不齐：不完整，报错文案指向新名单。
	partial := toSet(clawMirrorRequiredAssets[:len(clawMirrorRequiredAssets)-1])
	chosen, _, ok = clawMirrorPickAssetSet(partial)
	if ok {
		t.Fatal("缺 SHA256SUMS 的整包不该被接受")
	}
	missing := clawMirrorMissingAssets(partial, chosen)
	if len(missing) != 1 || missing[0] != "SHA256SUMS" {
		t.Fatalf("missing = %v", missing)
	}
}
