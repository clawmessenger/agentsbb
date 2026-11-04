package handler

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// claw_branding_test.go 覆盖品牌图配置里那几段「不需要数据库也能测、但错了会
// 静默出问题」的逻辑：
//
//   - URL 归一化：错了会让客户端拿到 javascript: 或空地址（一张空白图）；
//   - 保存时补全：错了会让服务端写进融云的仍是相对路径（手机端 404）；
//   - base 推导：错了会在反代后面把 http 当 https，或者丢掉端口。

func TestNormalizeBrandingImageURL(t *testing.T) {
	const base = "https://im.example.test"
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"绝对 https 原样保留", "https://cdn.example.test/a.png", "https://cdn.example.test/a.png"},
		{"绝对 http 原样保留", "http://cdn.example.test/a.png", "http://cdn.example.test/a.png"},
		{"站内相对路径补成绝对", "/uploads/branding/x.png", base + "/uploads/branding/x.png"},
		{"两侧空白被裁掉", "  https://cdn.example.test/a.png  ", "https://cdn.example.test/a.png"},
		{"空串表示没配", "", ""},
		{"纯空白也表示没配", "   ", ""},
		// 下面三条是安全闸：这个值会进 <img src>，不给奇怪 scheme 留口子。
		{"javascript 协议拒绝", "javascript:alert(1)", ""},
		{"data URI 拒绝", "data:image/png;base64,AAAA", ""},
		// 协议相对会被 url.Parse 当成 host，绕过 scheme 校验，必须单独挡。
		{"协议相对拒绝", "//evil.example.test/a.png", ""},
		{"相对路径但没有 base", "/uploads/a.png", ""},
		{"不含 host 又不是绝对路径", "uploads/a.png", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			useBase := base
			if tc.name == "相对路径但没有 base" {
				useBase = ""
			}
			if got := normalizeBrandingImageURL(tc.raw, useBase); got != tc.want {
				t.Errorf("normalizeBrandingImageURL(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}

func TestBrandingPublicBaseURL(t *testing.T) {
	// env 优先：运维钉死对外域名时不该被请求头带偏。
	t.Run("env 优先", func(t *testing.T) {
		t.Setenv(brandingPublicBaseEnv, "https://pinned.example.test/")
		req := httptest.NewRequest("GET", "http://internal.local/api/config/branding", nil)
		req.Host = "internal.local"
		if got, want := brandingPublicBaseURL(req), "https://pinned.example.test"; got != want {
			t.Errorf("got %q, want %q（env 应去掉尾斜杠并优先）", got, want)
		}
	})

	t.Run("反代头优先于 r.Host 与 r.TLS", func(t *testing.T) {
		t.Setenv(brandingPublicBaseEnv, "")
		req := httptest.NewRequest("GET", "http://127.0.0.1/api/config/branding", nil)
		req.Host = "127.0.0.1:8080"
		// 反代后面 r.TLS 恒为 nil，只能靠 X-Forwarded-Proto 判断 https。
		req.Header.Set("X-Forwarded-Proto", "https")
		req.Header.Set("X-Forwarded-Host", "newsradar.dreamdt.cn")
		if got, want := brandingPublicBaseURL(req), "https://newsradar.dreamdt.cn"; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("多重反代取第一个值", func(t *testing.T) {
		t.Setenv(brandingPublicBaseEnv, "")
		req := httptest.NewRequest("GET", "http://127.0.0.1/x", nil)
		req.Host = "127.0.0.1"
		req.Header.Set("X-Forwarded-Proto", "https, http")
		req.Header.Set("X-Forwarded-Host", "a.example.test, b.internal")
		if got, want := brandingPublicBaseURL(req), "https://a.example.test"; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("无代理头时退回请求自身", func(t *testing.T) {
		t.Setenv(brandingPublicBaseEnv, "")
		req := httptest.NewRequest("GET", "http://10.0.0.5:8080/api/config/branding", nil)
		req.Host = "10.0.0.5:8080"
		// 端口必须保住：丢掉它会让补全出来的 URL 指向 80 端口。
		if got, want := brandingPublicBaseURL(req), "http://10.0.0.5:8080"; got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})
}

func TestNormalizeBrandingConfigJSON(t *testing.T) {
	const base = "https://im.example.test"

	t.Run("相对路径落库前补成绝对", func(t *testing.T) {
		out, ok := normalizeBrandingConfigJSON(
			`{"user_avatar":"/uploads/branding/u.png","logo":"https://cdn.example.test/l.png"}`, base)
		if !ok {
			t.Fatal("合法 JSON 应返回 ok")
		}
		var got map[string]string
		if err := json.Unmarshal([]byte(out), &got); err != nil {
			t.Fatalf("回包不是合法 JSON：%v", err)
		}
		if want := base + "/uploads/branding/u.png"; got["user_avatar"] != want {
			t.Errorf("user_avatar = %q, want %q —— 服务端写融云时没有 request 上下文，"+
				"相对路径必须在保存时就补全", got["user_avatar"], want)
		}
		if got["logo"] != "https://cdn.example.test/l.png" {
			t.Errorf("logo = %q, want 原样保留", got["logo"])
		}
	})

	t.Run("非法地址存成空串而不是原样落库", func(t *testing.T) {
		out, ok := normalizeBrandingConfigJSON(`{"user_avatar":"javascript:alert(1)"}`, base)
		if !ok {
			t.Fatal("ok 应为 true（只是值被丢弃）")
		}
		var got map[string]string
		_ = json.Unmarshal([]byte(out), &got)
		if got["user_avatar"] != "" {
			t.Errorf("user_avatar = %q, want 空串（脏值不能进库）", got["user_avatar"])
		}
	})

	t.Run("五个槽位齐全且缺省为空串", func(t *testing.T) {
		out, ok := normalizeBrandingConfigJSON(`{"group_avatar":"https://cdn.example.test/g.png"}`, base)
		if !ok {
			t.Fatal("ok 应为 true")
		}
		var got map[string]string
		_ = json.Unmarshal([]byte(out), &got)
		for _, key := range []string{"user_avatar", "group_avatar", "discussion_avatar", "chatroom_avatar", "logo"} {
			if _, exists := got[key]; !exists {
				t.Errorf("缺 %q 键 —— 后台只提交一个字段时，其余槽位要显式存空串表示「用内置」", key)
			}
		}
	})

	t.Run("非法 JSON 不当作 branding 配置", func(t *testing.T) {
		for _, raw := range []string{"", "   ", "not-json", `[1,2]`, `"str"`, `null`} {
			if _, ok := normalizeBrandingConfigJSON(raw, base); ok {
				t.Errorf("%q 不该被当成 branding 配置", raw)
			}
		}
	})
}

// builtinBranding 是「配置为空时下发什么」的唯一定义，五项必须都是非空绝对 URL：
// 少一项就会让客户端拿到空串，直接显示一张空白图。
func TestBuiltinBrandingIsComplete(t *testing.T) {
	t.Setenv(brandingPublicBaseEnv, "")
	t.Setenv(brandingLogoEnv, "")
	t.Setenv("CLAW_GROUP_PORTRAIT_BASE", "")
	t.Setenv("CLAW_DEFAULT_PORTRAIT_URI", "")

	cfg := builtinBranding()
	fields := map[string]string{
		"user_avatar":       cfg.UserAvatar,
		"group_avatar":      cfg.GroupAvatar,
		"discussion_avatar": cfg.DiscussionAvatar,
		"chatroom_avatar":   cfg.ChatroomAvatar,
		"logo":              cfg.Logo,
	}
	for key, value := range fields {
		if strings.TrimSpace(value) == "" {
			t.Errorf("%s 为空 —— 未配置时要回落内置图，不能下发空地址", key)
			continue
		}
		if !strings.HasPrefix(value, "http://") && !strings.HasPrefix(value, "https://") {
			t.Errorf("%s = %q，内置值必须是绝对 URL（小程序与融云都不接受相对路径）", key, value)
		}
	}
	// 三张群图不能是同一张：那样后台没配的时候三类群又没法区分了。
	if cfg.GroupAvatar == cfg.DiscussionAvatar || cfg.DiscussionAvatar == cfg.ChatroomAvatar {
		t.Error("三张群类默认图不能相同")
	}
}

func TestLooksLikeImage(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0}
	jpeg := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0}
	webp := append([]byte("RIFF"), append([]byte{0, 0, 0, 0}, []byte("WEBP")...)...)
	svg := []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>`)
	notImage := []byte("MZ\x90\x00 this is an exe")

	if !looksLikeImage(png, "image/png") {
		t.Error("PNG 应通过")
	}
	if !looksLikeImage(jpeg, "image/jpeg") {
		t.Error("JPEG 应通过")
	}
	if !looksLikeImage(webp, "image/webp") {
		t.Error("WEBP 应通过")
	}
	if !looksLikeImage(svg, "image/svg+xml") {
		t.Error("SVG 应通过（XML 声明在 <svg 之前）")
	}
	if looksLikeImage(notImage, "image/png") {
		t.Error("非图片内容必须被拒 —— 否则任意文件能塞进图片槽位")
	}
	if looksLikeImage([]byte("short"), "image/png") {
		t.Error("过短的内容必须被拒")
	}
}
