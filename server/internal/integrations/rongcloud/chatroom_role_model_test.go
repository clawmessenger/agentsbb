package rongcloud

// WEB-053 回归：改角色模型必须同时落到「成员卡片读的那份数据」和「派发读的
// 角色板」上。前者由 UpdateRongCloudChatroomMemberDiscussionModel 覆盖，后者
// 由 patchRoleSnapshotModel 打补丁 —— 这里只测后者这个纯函数，因为它是唯一
// 容易写错键名、又只能靠肉眼发现的地方。

import (
	"encoding/json"
	"testing"
)

func TestPatchRoleSnapshotModelUpdatesOnlyTargetMember(t *testing.T) {
	raw := []byte(`{
		"rc-a": {"memberId":"rc-a","nodeId":"node-a","roleName":"分析师","model":"quukk/glm-5.2","speakingOrder":1},
		"rc-b": {"memberId":"rc-b","nodeId":"node-b","roleName":"验证者","model":"quukk/glm-5.2","speakingOrder":2}
	}`)

	next, ok := patchRoleSnapshotModel(raw, "rc-b", "quukk/glm-5.3-flash")
	if !ok {
		t.Fatalf("expected snapshot to change")
	}
	var snapshot map[string]map[string]interface{}
	if err := json.Unmarshal(next, &snapshot); err != nil {
		t.Fatalf("patched snapshot is not valid json: %v", err)
	}
	if got := snapshot["rc-b"]["model"]; got != "quukk/glm-5.3-flash" {
		t.Fatalf("target member model = %v, want quukk/glm-5.3-flash", got)
	}
	if got := snapshot["rc-a"]["model"]; got != "quukk/glm-5.2" {
		t.Fatalf("untouched member model = %v, want quukk/glm-5.2", got)
	}
	// 其它字段必须原样保留：派发读 roleName / speakingOrder，丢了会让轮次乱序。
	if got := snapshot["rc-b"]["roleName"]; got != "验证者" {
		t.Fatalf("roleName = %v, want 验证者", got)
	}
	if got := snapshot["rc-b"]["speakingOrder"]; got != float64(2) {
		t.Fatalf("speakingOrder = %v, want 2", got)
	}
}

func TestPatchRoleSnapshotModelClearsModelForNodeDefault(t *testing.T) {
	raw := []byte(`{"rc-a":{"memberId":"rc-a","model":"quukk/glm-5.2"}}`)

	next, ok := patchRoleSnapshotModel(raw, "rc-a", "")
	if !ok {
		t.Fatalf("expected snapshot to change")
	}
	var snapshot map[string]map[string]interface{}
	if err := json.Unmarshal(next, &snapshot); err != nil {
		t.Fatalf("patched snapshot is not valid json: %v", err)
	}
	if _, exists := snapshot["rc-a"]["model"]; exists {
		t.Fatalf("model should be removed so dispatch falls back to the node default")
	}
}

func TestPatchRoleSnapshotModelSkipsNoopAndUnknownMember(t *testing.T) {
	raw := []byte(`{"rc-a":{"memberId":"rc-a","model":"quukk/glm-5.2"}}`)

	if _, ok := patchRoleSnapshotModel(raw, "rc-a", "quukk/glm-5.2"); ok {
		t.Fatalf("same model must not rewrite the snapshot")
	}
	if _, ok := patchRoleSnapshotModel(raw, "rc-missing", "quukk/glm-5.3"); ok {
		t.Fatalf("unknown member must not rewrite the snapshot")
	}
	if _, ok := patchRoleSnapshotModel(nil, "rc-a", "quukk/glm-5.3"); ok {
		t.Fatalf("empty snapshot must not rewrite the snapshot")
	}
	if _, ok := patchRoleSnapshotModel([]byte("not-json"), "rc-a", "quukk/glm-5.3"); ok {
		t.Fatalf("invalid snapshot must not rewrite the snapshot")
	}
}
