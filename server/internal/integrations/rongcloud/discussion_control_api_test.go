package rongcloud

import (
	"context"
	"encoding/json"
	"testing"
)

// 门面层的单元测试不碰数据库：这里验证的是「参数整形与失败口径」，真正的
// 业务判断都在 action 里，由既有用例覆盖。

func TestControlOutcomeFromResultDefaultsToOK(t *testing.T) {
	out := controlOutcome(commandResult{data: map[string]interface{}{"chatroom_id": "c1"}})
	if !out.OK() {
		t.Fatalf("expected OK, got code %d", out.Code)
	}
	if got := out.Data["chatroom_id"]; got != "c1" {
		t.Fatalf("data not passed through: %#v", out.Data)
	}
}

func TestControlOutcomeKeepsErrorData(t *testing.T) {
	out := controlOutcome(commandResult{
		code:    429,
		message: "QUOTA_EXCEEDED",
		data:    map[string]interface{}{"kind": "discussion", "limit": 3},
	})
	if out.OK() {
		t.Fatal("429 must not be OK")
	}
	if out.Message != "QUOTA_EXCEEDED" {
		t.Fatalf("message = %q", out.Message)
	}
	if out.Data["limit"] != 3 {
		t.Fatalf("error data dropped: %#v", out.Data)
	}
}

func TestControlOutcomeWrapsNonMapData(t *testing.T) {
	out := controlOutcome(commandResult{code: 200, data: []string{"a"}})
	if _, ok := out.Data["value"]; !ok {
		t.Fatalf("non-map data should be wrapped, got %#v", out.Data)
	}
}

func TestLifecycleRejectsUnknownActionBeforeTouchingDB(t *testing.T) {
	control := newDiscussionControl(&discussionRuntime{}, nil)
	outcome, err := control.Lifecycle(context.Background(), "user-1", "bogus", LifecycleRequest{ChatroomID: "room-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Code != 400 || outcome.Message != "UNKNOWN_LIFECYCLE_ACTION" {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestCreateRoundtableRequiresTopic(t *testing.T) {
	control := newDiscussionControl(&discussionRuntime{}, nil)
	outcome, err := control.CreateRoundtable(context.Background(), "user-1", CreateRoundtableRequest{Topic: "   "})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Code != 400 || outcome.Message != "TOPIC_REQUIRED" {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestSetupStateRequiresChatroom(t *testing.T) {
	control := newDiscussionControl(&discussionRuntime{}, nil)
	outcome, err := control.SetupState(context.Background(), "user-1", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Code != 400 || outcome.Message != "CHATROOM_ID_REQUIRED" {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestConfirmRoundtableRequiresRecommendation(t *testing.T) {
	control := newDiscussionControl(&discussionRuntime{}, nil)
	outcome, err := control.ConfirmRoundtable(context.Background(), "user-1", ConfirmRoundtableRequest{ChatroomID: "room-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Code != 400 || outcome.Message != "INVALID_ROUNDTABLE_REQUEST" {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestLifecycleActionsCoverTheV3UserActions(t *testing.T) {
	// v3 引擎认领的用户动作是 interactiveLifecycleActions 那个集合；门面必须
	// 与之逐项对齐，多一个会打到 handled=false，少一个则能力缺失。
	for action := range interactiveLifecycleActions {
		if !LifecycleActions[action] {
			t.Fatalf("lifecycle action %q missing from DiscussionControl", action)
		}
	}
	for action := range LifecycleActions {
		if !interactiveLifecycleActions[action] {
			t.Fatalf("DiscussionControl exposes action %q that v3 engine does not handle", action)
		}
	}
}

// 推荐行落库时角色是 snake_case（role_id / role_name / role_prompt / node_id），
// confirm 的默认全选必须按这个形状拼回 command params —— 这里用一条真实的
// 推荐 JSON 走一遍 ConfirmRole 的映射，防止字段名漂移后静默丢角色。
func TestConfirmRoleMappingFromRecommendationJSON(t *testing.T) {
	raw := []byte(`[{"role_id":"r1","role_name":"主持人","role_prompt":"引导讨论","node_id":"node-a"}]`)
	var recommended []map[string]interface{}
	if err := json.Unmarshal(raw, &recommended); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	role := ConfirmRole{
		RoleID:     stringValue(recommended[0]["role_id"]),
		RoleName:   stringValue(recommended[0]["role_name"]),
		RolePrompt: stringValue(recommended[0]["role_prompt"]),
		NodeID:     stringValue(recommended[0]["node_id"]),
	}
	if role.RoleID != "r1" || role.RoleName != "主持人" || role.RolePrompt != "引导讨论" || role.NodeID != "node-a" {
		t.Fatalf("mapping drifted: %+v", role)
	}
}
