package rongcloud

import (
	"os"
	"testing"
)

// branding_override_test.go 钉住「默认头像 URL 的解析优先级」。
//
// 这条优先级是后台可配置的基础：后台配了就必须盖住 env 和内置常量，否则运营在
// 后台换的图会被几个月前部署时留下的 env 悄悄盖回去 —— 那是最难查的一类故障
// （后台显示已保存、线上就是不变）。

func withCleanBranding(t *testing.T) {
	t.Helper()
	SetBrandingOverrides(BrandingOverrides{})
	t.Cleanup(func() { clearBrandingOverrides() })
}

func TestGroupPortraitURIOverrideBeatsEnvAndBuiltin(t *testing.T) {
	withCleanBranding(t)
	t.Setenv(GroupPortraitBaseEnv, "https://cdn.example.test/ga")

	// 没有 override 时走 env 基址。
	if got, want := GroupPortraitURI(GroupPortraitKindGroup), "https://cdn.example.test/ga/group.png"; got != want {
		t.Fatalf("GroupPortraitURI(group) = %q, want %q", got, want)
	}

	SetBrandingOverrides(BrandingOverrides{
		GroupAvatar:      "https://cdn.example.test/brand/group-v2.png",
		DiscussionAvatar: "https://cdn.example.test/brand/discussion-v2.png",
		ChatroomAvatar:   "https://cdn.example.test/brand/chatroom-v2.png",
	})

	// override 必须盖住 env：这是「后台改了要生效」的最核心一条。
	cases := map[string]string{
		GroupPortraitKindGroup:      "https://cdn.example.test/brand/group-v2.png",
		GroupPortraitKindDiscussion: "https://cdn.example.test/brand/discussion-v2.png",
		GroupPortraitKindChatroom:   "https://cdn.example.test/brand/chatroom-v2.png",
	}
	for kind, want := range cases {
		if got := GroupPortraitURI(kind); got != want {
			t.Errorf("GroupPortraitURI(%q) = %q, want %q", kind, got, want)
		}
	}
}

// 只配了一个 kind 时，另外两个必须继续用基址拼 —— 不能因为一个 override 就
// 让没配的那两类变成空串或复用同一张图。
func TestGroupPortraitURIPartialOverride(t *testing.T) {
	withCleanBranding(t)
	t.Setenv(GroupPortraitBaseEnv, "")
	SetBrandingOverrides(BrandingOverrides{GroupAvatar: "https://cdn.example.test/only-group.png"})

	if got := GroupPortraitURI(GroupPortraitKindGroup); got != "https://cdn.example.test/only-group.png" {
		t.Errorf("group = %q, want the override", got)
	}
	// 另外两类回落内置基址。
	if got, want := GroupPortraitURI(GroupPortraitKindDiscussion), DefaultGroupPortraitBaseURL+"/discussion.png"; got != want {
		t.Errorf("discussion = %q, want %q (未配置的 kind 不能跟着变)", got, want)
	}
	if got, want := GroupPortraitURI(GroupPortraitKindChatroom), DefaultGroupPortraitBaseURL+"/chatroom.png"; got != want {
		t.Errorf("chatroom = %q, want %q", got, want)
	}
}

func TestDefaultUserPortraitOverrideBeatsEnv(t *testing.T) {
	withCleanBranding(t)
	t.Setenv("CLAW_DEFAULT_PORTRAIT_URI", "https://cdn.example.test/env-default.png")
	if got := DefaultUserPortrait(); got != "https://cdn.example.test/env-default.png" {
		t.Fatalf("没有 override 时应走 env，got %q", got)
	}

	SetBrandingOverrides(BrandingOverrides{UserAvatar: "https://cdn.example.test/brand/user-v2.png"})
	if got := DefaultUserPortrait(); got != "https://cdn.example.test/brand/user-v2.png" {
		t.Errorf("DefaultUserPortrait() = %q, want the override", got)
	}
	// 未知 kind 仍然回落「当前生效的统一默认图」，也就是 override 之后的值。
	if got := GroupPortraitURI("bogus"); got != "https://cdn.example.test/brand/user-v2.png" {
		t.Errorf("未知 kind 应回落到 override 后的统一默认图，got %q", got)
	}
}

// IsGroupDefaultPortrait 认不认 override 直接决定回填脚本会不会把后台配的图
// 当成「用户自定义头像」而跳过。这条是回填正确性的闸门。
func TestIsGroupDefaultPortraitRecognizesOverride(t *testing.T) {
	withCleanBranding(t)
	const override = "https://cdn.example.test/brand/group-v2.png"
	SetBrandingOverrides(BrandingOverrides{GroupAvatar: override})

	if !IsGroupDefaultPortrait(override) {
		t.Fatal("override 的完整 URL 必须被认成我方默认图")
	}
	// 同一张图带缓存参数：运营换图后很容易带上 `?v=2`，认死字符串会让回填跳过它。
	if !IsGroupDefaultPortrait(override + "?v=2") {
		t.Error("带 query 的同图也应被认出（否则回填会把它当自定义图跳过）")
	}
	// scheme 不同但 host+path 相同：同一份对象存储的两种暴露方式，仍是同一张图。
	if !IsGroupDefaultPortrait("http://cdn.example.test/brand/group-v2.png") {
		t.Error("http/https 差异不该改变「这是我方图」的判断")
	}
	// host 不同但 path 相同 —— 别人 CDN 上恰好同名的图，绝不能当成我方的。
	if IsGroupDefaultPortrait("https://other.example.test/brand/group-v2.png") {
		t.Error("host 不同就是别人的图，不能认")
	}
	// 无 override 时，内置基址拼出来的仍然要认（老行为不能坏）。
	SetBrandingOverrides(BrandingOverrides{})
	if !IsGroupDefaultPortrait(DefaultGroupPortraitBaseURL + "/group.png") {
		t.Error("内置基址的群图必须继续被认出")
	}
}

// 空 override 等于没配：不能出现「配了空串就把头像变成空 URL」的情况。
func TestSetBrandingOverridesTrimsAndTreatsBlankAsUnset(t *testing.T) {
	withCleanBranding(t)
	SetBrandingOverrides(BrandingOverrides{
		UserAvatar:  "   ",
		GroupAvatar: "  https://cdn.example.test/g.png  ",
	})
	got := CurrentBrandingOverrides()
	if got.UserAvatar != "" {
		t.Errorf("纯空白的 override 应归一成空串，got %q", got.UserAvatar)
	}
	if got.GroupAvatar != "https://cdn.example.test/g.png" {
		t.Errorf("两侧空白应被裁掉，got %q", got.GroupAvatar)
	}
	// 空 override 的 kind 继续回落，不会返回空串。
	if v := GroupPortraitURI(GroupPortraitKindGroup); v == "" {
		t.Fatal("override 为空时绝不能返回空 URL（融云会显示空白而不是默认图）")
	}
}

// GroupDefaultPortraitURIs 是回填 SQL 的预筛集合，override 之后必须包含新 URL，
// 否则回填会「只认旧 URL、把新图当自定义图」。
func TestGroupDefaultPortraitURIsIncludeOverrides(t *testing.T) {
	withCleanBranding(t)
	t.Setenv(GroupPortraitBaseEnv, "")
	SetBrandingOverrides(BrandingOverrides{
		UserAvatar:  "https://cdn.example.test/u.png",
		GroupAvatar: "https://cdn.example.test/g.png",
	})

	uris := GroupDefaultPortraitURIs()
	want := map[string]bool{
		"https://cdn.example.test/u.png": false,
		"https://cdn.example.test/g.png": false,
	}
	for _, u := range uris {
		if _, ok := want[u]; ok {
			want[u] = true
		}
	}
	for u, found := range want {
		if !found {
			t.Errorf("%q 不在 GroupDefaultPortraitURIs() 里：%v", u, uris)
		}
	}
}

// 测试之间必须互不污染：clearBrandingOverrides 之后一切回到内置。
func TestBrandingOverridesReset(t *testing.T) {
	withCleanBranding(t)
	SetBrandingOverrides(BrandingOverrides{GroupAvatar: "https://cdn.example.test/x.png"})
	clearBrandingOverrides()
	if os.Getenv("CLAW_DEFAULT_PORTRAIT_URI") == "" {
		if got := DefaultUserPortrait(); got != DefaultUserPortraitURI {
			t.Errorf("复位后应回到内置图源，got %q", got)
		}
	}
	if got, want := GroupPortraitURI(GroupPortraitKindGroup), DefaultGroupPortraitBaseURL+"/group.png"; got != want {
		t.Errorf("复位后群图应回内置基址，got %q want %q", got, want)
	}
}
