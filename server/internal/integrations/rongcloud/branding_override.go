package rongcloud

import (
	"net/url"
	"strings"
	"sync"
)

// branding_override.go 让「默认头像 URL」可以在后台改，而不是写死在代码里。
//
// 背景：默认头像有三份定义 —— web 读 `public/default_user.png` 与
// `public/group-avatars/*.svg`，小程序读打进包的 `static/*`，而**服务端写进融云
// 群资料 / rongcloud_chatroom 的那份 URL 是这里的常量**。运营换一张默认图，过去
// 要改代码 + 重新构建 + 重新部署三端；现在后台「系统配置 → 品牌图片」存一行
// `rongcloud_system_config`（config_key='branding'），进程内投影成这个结构。
//
// 三条纪律：
//  1. **override 必须已经是绝对 URL**。后台保存时会先归一化（相对路径按请求
//     Host 补全），因为这里被调用的场合（建群写融云、启动日志、回填脚本）没有
//     request 上下文，拿不到 Host。
//  2. **空串 = 没配 = 用内置**。不要用空串表达「故意不给头像」——那会让融云
//     收到空 portraitUri，客户端显示空白而不是默认图。
//  3. **优先级 override > env > 内置常量**。后台是运营操作，env 是部署兜底，
//     运营改完不该被几个月前留下的 env 盖回去。
//
// 并发：只在后台保存 / 启动加载时整体替换，读侧 RWMutex，不单独改字段。

// BrandingOverrides 是后台配置在进程内的投影。字段与 web / 小程序的槽位一一对应：
// `user_avatar` / `group_avatar` / `discussion_avatar` / `chatroom_avatar` / `logo`。
type BrandingOverrides struct {
	UserAvatar       string
	GroupAvatar      string
	DiscussionAvatar string
	ChatroomAvatar   string
	Logo             string
}

var (
	brandingMu        sync.RWMutex
	brandingOverrides BrandingOverrides
)

// SetBrandingOverrides 整体替换当前配置（空值字段会被当成"没配"，读侧回落内置）。
// 传零值等于清空所有 override。
func SetBrandingOverrides(o BrandingOverrides) {
	brandingMu.Lock()
	defer brandingMu.Unlock()
	brandingOverrides = BrandingOverrides{
		UserAvatar:       strings.TrimSpace(o.UserAvatar),
		GroupAvatar:      strings.TrimSpace(o.GroupAvatar),
		DiscussionAvatar: strings.TrimSpace(o.DiscussionAvatar),
		ChatroomAvatar:   strings.TrimSpace(o.ChatroomAvatar),
		Logo:             strings.TrimSpace(o.Logo),
	}
}

// CurrentBrandingOverrides 返回当前配置的副本（只读用，别指望改它能生效）。
func CurrentBrandingOverrides() BrandingOverrides {
	brandingMu.RLock()
	defer brandingMu.RUnlock()
	return brandingOverrides
}

// userPortrait 返回用户默认头像的 override，空串表示没配。
func (o BrandingOverrides) userPortrait() string {
	return strings.TrimSpace(o.UserAvatar)
}

// groupPortrait 返回某类群默认头像的 override，空串表示没配。
//
// 只认三个已知 kind：调用方传进来的字符串绝不直接参与拼装（历史教训见
// `GroupPortraitURI` 的注释）。
func (o BrandingOverrides) groupPortrait(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case GroupPortraitKindGroup:
		return strings.TrimSpace(o.GroupAvatar)
	case GroupPortraitKindDiscussion:
		return strings.TrimSpace(o.DiscussionAvatar)
	case GroupPortraitKindChatroom:
		return strings.TrimSpace(o.ChatroomAvatar)
	}
	return ""
}

// brandingOverridesAreZero 判断是否一个字段都没配（用于跳过无意义的写锁）。
func brandingOverridesAreZero(o BrandingOverrides) bool {
	return o.UserAvatar == "" && o.GroupAvatar == "" &&
		o.DiscussionAvatar == "" && o.ChatroomAvatar == "" && o.Logo == ""
}

// sameImageURL 判断两个图片地址是不是同一张图。
//
// 判据刻意宽松：忽略 scheme、query、hash，只比 host + path。
//   - 忽略 scheme：同一份对象存储可能同时以 http/https 暴露，写进融云的是哪个都
//     不该影响"这是我方默认图"的判断；
//   - 忽略 query/hash：`?v=2` 这类缓存参数换图后会被运营带上，认死字符串会让
//     override 一加上参数就退化成"用户自定义图"，回填随即跳过它。
//
// 但 host + path 必须同时相等 —— 只比 path 会把别人 CDN 上恰好同名的图算成我方图。
func sameImageURL(a, b string) bool {
	pa, err := url.Parse(strings.TrimSpace(a))
	if err != nil {
		return false
	}
	pb, err := url.Parse(strings.TrimSpace(b))
	if err != nil {
		return false
	}
	if !strings.EqualFold(pa.Host, pb.Host) {
		return false
	}
	return strings.TrimRight(pa.Path, "/") == strings.TrimRight(pb.Path, "/")
}

// clearBrandingOverridesForTest 仅供测试复位（导出给同包的 _test 用不划算，
// 但其他包（handler）的测试需要隔离状态，因此走 `SetBrandingOverrides` 零值，
// 这里保留一个内部别名避免误用）。
func clearBrandingOverrides() {
	brandingMu.Lock()
	defer brandingMu.Unlock()
	brandingOverrides = BrandingOverrides{}
}
