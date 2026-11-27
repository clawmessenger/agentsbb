package rongcloud

import (
	"context"
	"testing"
)

// 讨论组成员头像修复：成员表写真实头像而非统一默认图。
//
// memberPortraitFor 在拿不到用户记录（service 未装配 / 融云 id 为空 / 查库失败）
// 时必须回退统一默认图，绝不阻断建组主流程。真实头像命中路径由建组 DB 集成
// 测试与线上数据核对覆盖（member 表 portrait_uri 应与融云用户表一致）。
func TestMemberPortraitForFallbackToDefault(t *testing.T) {
	t.Setenv("CLAW_DEFAULT_PORTRAIT_URI", "")
	ctx := context.Background()

	// nil service / 空 id：直接回退，不 panic。
	var nilSvc *roundtableCreationService
	if got := nilSvc.memberPortraitFor(ctx, "codex_123"); got != DefaultUserPortrait() {
		t.Fatalf("nil service portrait = %q, want default %q", got, DefaultUserPortrait())
	}
	empty := &roundtableCreationService{}
	if got := empty.memberPortraitFor(ctx, ""); got != DefaultUserPortrait() {
		t.Fatalf("empty id portrait = %q, want default %q", got, DefaultUserPortrait())
	}
	// queries 未装配：建组未接 DB 的纯内存路径同样回退，不报错。
	if got := empty.memberPortraitFor(ctx, "codex_123"); got != DefaultUserPortrait() {
		t.Fatalf("no queries portrait = %q, want default %q", got, DefaultUserPortrait())
	}
}
