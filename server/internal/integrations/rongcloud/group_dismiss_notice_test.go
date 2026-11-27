package rongcloud

import (
	"context"
	"strings"
	"testing"
)

// 融云的 /group/dismiss.json 不向客户端推 RC:GrpNtf，也不删成员本地会话，
// 成员不刷新就一直看到已解散的群。后端必须在解散前补发一条 group_dismissed
// 通知，各端收到即按 groupId 摘掉会话。
func TestGroupDismissPublishesNoticeBeforeDismissing(t *testing.T) {
	rec, srv := newGroupTestServer(t)
	defer srv.Close()
	stub := newGroupMirrorStub()
	stub.owners["100001"] = "user-7"
	stub.profile(GroupProfile{GroupID: "100001", GroupName: "G"})
	handler := newGroupCommandHandler(t, rec, srv, stub.mirror())

	if err := handler.handleCommand(context.Background(),
		groupCommand("dismiss", "user-7", `{"groupId":"100001"}`)); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}

	publishes := rec.calls("/message/group/publish.json")
	if len(publishes) != 1 {
		t.Fatalf("group publishes = %d, want 1", len(publishes))
	}
	notice := publishes[0]
	if got := notice["objectName"]; got != objectNameGroupDismissed {
		t.Errorf("objectName = %q, want %q", got, objectNameGroupDismissed)
	}
	// 发送者必须是群成员（融云校验），群主本人；不能用 system。
	if got := notice["fromUserId"]; got != "user-7" {
		t.Errorf("fromUserId = %q, want the group owner", got)
	}
	if got := notice["toGroupId"]; got != "100001" {
		t.Errorf("toGroupId = %q, want the dismissed group id", got)
	}
	if !strings.Contains(notice["content"], `"groupId":"100001"`) {
		t.Errorf("notice content = %q, want groupId inside", notice["content"])
	}

	// 通知必须早于融云 dismiss：群一旦解散就再也发不进去了。
	noticeAt, dismissAt := -1, -1
	for i, path := range rec.paths {
		switch path {
		case "/message/group/publish.json":
			if noticeAt < 0 {
				noticeAt = i
			}
		case "/group/dismiss.json":
			if dismissAt < 0 {
				dismissAt = i
			}
		}
	}
	if noticeAt < 0 || dismissAt < 0 || noticeAt >= dismissAt {
		t.Fatalf("publish index=%d dismiss index=%d: notice must precede dismiss; paths=%v",
			noticeAt, dismissAt, rec.paths)
	}
}

// 通知发布失败不能回滚已经成功的解散（群关系已删，重发无意义）。
func TestGroupDismissSucceedsWhenNoticePublishFails(t *testing.T) {
	rec, srv := newGroupTestServer(t)
	defer srv.Close()
	rec.failPaths["/message/group/publish.json"] = true
	stub := newGroupMirrorStub()
	stub.owners["100001"] = "user-7"
	stub.profile(GroupProfile{GroupID: "100001", GroupName: "G"})
	handler := newGroupCommandHandler(t, rec, srv, stub.mirror())

	if err := handler.handleCommand(context.Background(),
		groupCommand("dismiss", "user-7", `{"groupId":"100001"}`)); err != nil {
		t.Fatalf("handleCommand: %v", err)
	}
	if dismisses := rec.calls("/group/dismiss.json"); len(dismisses) != 1 {
		t.Fatalf("dismisses = %#v, want the group still dismissed", dismisses)
	}
	if len(stub.deleted) != 1 {
		t.Errorf("mirror deleted = %#v", stub.deleted)
	}
}
