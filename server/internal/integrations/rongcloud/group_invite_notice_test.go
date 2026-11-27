package rongcloud

import (
	"context"
	"strings"
	"testing"
)

// 建群只写成员关系、不产生消息；融云会话列表是「有消息才有会话」，
// 因此必须补一条持久化群消息，才能既当入群通知、又让被邀请者的会话列表
// 立刻出现该群。
func TestGroupCreatePublishesInviteNotice(t *testing.T) {
	rec, srv := newGroupTestServer(t)
	defer srv.Close()
	handler := newGroupCommandHandler(t, rec, srv, newGroupMirrorStub().mirror())

	msg := groupCommand("create", "user-7", `{"groupName":"产品讨论","memberIds":["user-8"]}`)
	if err := handler.handleCommand(context.Background(), msg); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}

	publishes := rec.calls("/message/group/publish.json")
	if len(publishes) != 1 {
		t.Fatalf("group publishes = %d, want 1", len(publishes))
	}
	notice := publishes[0]
	// 发送者必须是群主本人（群成员），不能用 system。
	if got := notice["fromUserId"]; got != "user-7" {
		t.Errorf("fromUserId = %q, want the group owner (message sender)", got)
	}
	if got := notice["toGroupId"]; got != "100001" {
		t.Errorf("toGroupId = %q, want the allocated group id", got)
	}
	if got := notice["objectName"]; got != objectNameText {
		t.Errorf("objectName = %q, want %q", got, objectNameText)
	}
	// 内置文本类型才保证所有端都能收到、会话列表都会生成。
	if !strings.Contains(notice["content"], "产品讨论") {
		t.Errorf("notice content = %q, want the group name inside", notice["content"])
	}
}

// 后加人场景同理：新成员也要立刻看到群聊，群内其他人也要看到入群提示。
func TestGroupAddMemberPublishesInviteNotice(t *testing.T) {
	rec, srv := newGroupTestServer(t)
	defer srv.Close()
	stub := newGroupMirrorStub()
	stub.member("100001", "user-7", "member")
	handler := newGroupCommandHandler(t, rec, srv, stub.mirror())

	msg := groupCommand("addMember", "user-7", `{"groupId":"100001","userIds":["user-8"]}`)
	if err := handler.handleCommand(context.Background(), msg); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}

	publishes := rec.calls("/message/group/publish.json")
	if len(publishes) != 1 {
		t.Fatalf("group publishes = %d, want 1", len(publishes))
	}
	notice := publishes[0]
	if got := notice["fromUserId"]; got != "user-7" {
		t.Errorf("fromUserId = %q, want the inviter (already a group member)", got)
	}
	if got := notice["toGroupId"]; got != "100001" {
		t.Errorf("toGroupId = %q", got)
	}
	if !strings.Contains(notice["content"], "加入群聊") {
		t.Errorf("notice content = %q, want an invite text", notice["content"])
	}
}

// 通知是 best-effort：发布失败不能把已经成功的建群变成失败。
func TestGroupCreateSucceedsWhenNoticePublishFails(t *testing.T) {
	rec, srv := newGroupTestServer(t)
	defer srv.Close()
	rec.failPaths["/message/group/publish.json"] = true
	stub := newGroupMirrorStub()
	handler := newGroupCommandHandler(t, rec, srv, stub.mirror())

	msg := groupCommand("create", "user-7", `{"groupName":"产品讨论","memberIds":["user-8"]}`)
	if err := handler.handleCommand(context.Background(), msg); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}
	if got := rec.callCount("/group/create.json"); got != 1 {
		t.Errorf("group/create calls = %d, want 1", got)
	}
	if len(stub.saved) != 1 {
		t.Fatalf("mirror saved = %d, want 1", len(stub.saved))
	}
	data, ok := groupResultData(t, rec).(map[string]interface{})
	if !ok || data["groupId"] != "100001" {
		t.Fatalf("create result = %#v, want the created group id", data)
	}
}
