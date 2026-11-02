package rongcloud

import (
	"context"
	"fmt"
	"net/url"
	"strings"
)

// userInfoResult holds the response from getUserInfo.
type userInfoResult struct {
	UserID      string `json:"userId"`
	Name        string `json:"name"`
	PortraitURI string `json:"portraitUri"`
}

// getUserToken registers or retrieves a RongCloud IM token for a user.
func (c *rongcloudAPIClient) getUserToken(ctx context.Context, userID, name, portraitURI string) (string, error) {
	form := url.Values{
		"userId":      {userID},
		"name":        {name},
		"portraitUri": {portraitURI},
	}
	result, err := c.postForm(ctx, "/user/getToken.json", form)
	if err != nil {
		return "", err
	}
	token, _ := result["token"].(string)
	return token, nil
}

// refreshUser refreshes a user's info in RongCloud. Empty name/portraitURI
// fields are omitted (RongCloud leaves them untouched), matching the legacy
// Python client's optional-field semantics.
func (c *rongcloudAPIClient) refreshUser(ctx context.Context, userID, name, portraitURI string) (string, error) {
	form := url.Values{"userId": {userID}}
	if name != "" {
		form.Set("name", name)
	}
	if portraitURI != "" {
		form.Set("portraitUri", portraitURI)
	}
	result, err := c.postForm(ctx, "/user/refresh.json", form)
	if err != nil {
		return "", err
	}
	token, _ := result["token"].(string)
	return token, nil
}

// checkOnline returns true if the user is currently online.
func (c *rongcloudAPIClient) checkOnline(ctx context.Context, userID string) (bool, error) {
	form := url.Values{"userId": {userID}}
	result, err := c.postForm(ctx, "/user/checkOnline.json", form)
	if err != nil {
		return false, err
	}
	status, _ := result["status"].(string)
	return status == "1", nil
}

// expireToken invalidates tokens issued before the given timestamp (ms).
func (c *rongcloudAPIClient) expireToken(ctx context.Context, userID string, timestampMs int64) error {
	form := url.Values{
		"userId": {userID},
		"time":   {fmt.Sprintf("%d", timestampMs)},
	}
	_, err := c.postForm(ctx, "/user/token/expire.json", form)
	return err
}

// RongCloud /friend/add.json optType values. The endpoint carries both
// behaviours through one parameter: 2 creates the edge immediately, 1 sends a
// friend *application* that the target has to accept (the edge only exists
// after that).
const (
	friendOptTypeRequest = "1"
	friendOptTypeDirect  = "2"

	// friendCodeAlreadyFriends 是融云的「双方已经是好友」码。它在 /friend/add.json
	// 里可能出现在两处：顶层 code（本次调用被判成业务错误），或 200 响应体里的
	// processCode（对方把「添加好友权限」设成了任何人可直接添加，这次直接成了好友、
	// 没有产生申请）。两处都表示**边存在**。
	friendCodeAlreadyFriends = 25460
	// friendCodePendingApproval 是 /friend/add.json 的 processCode「待对方同意」：
	// 申请确实建立了，但**好友边没有建立**。权威语义见 web 端
	// clawmessenger-web/src/services/contacts.ts:376-388（FRIEND_CODE_PENDING）。
	friendCodePendingApproval = 25461
)

// friendAddOutcome 是 /friend/add.json 的**三态**结果。
//
// 为什么不能只看 HTTP 层 code：postForm 把 `code == 200` 当成功返回 nil error，可
// 融云在 200 的同时会用响应体里的 processCode 表达「这次到底建没建边」。旧实现
// 只区分「没报错 / 25460」，于是 processCode=25461（只产生待同意申请）被当成
// 「边建好了」—— 审批回 success、拥有者界面显示已同意，请求方的联系人里却没有
// 拥有者。addFriendWithOptType 保持两返回值语义不变（老调用方不动），需要区分
// 三态的调用方走 addFriendDetailed。
type friendAddOutcome int

const (
	// friendAddUnknown 是零值，只在**报错时**返回；调用方必须先看 error。
	friendAddUnknown friendAddOutcome = iota
	// friendAddLinked 边确实建立了。
	friendAddLinked
	// friendAddExisting 双方本来就是好友，本次调用没有新建边（回滚时不能撤它）。
	friendAddExisting
	// friendAddPending 只产生了一条待对方同意的申请，**边没有建立**。
	friendAddPending
)

func (o friendAddOutcome) String() string {
	switch o {
	case friendAddLinked:
		return "linked"
	case friendAddExisting:
		return "existing"
	case friendAddPending:
		return "pending"
	default:
		return "unknown"
	}
}

// addFriend creates a one-way RongCloud friend relation from userID to
// friendID with optType=2 (direct add, no approval step). The legacy Python
// backend used the same call when binding a device so the node user showed up
// in the owner's IM friend list. RongCloud answers 25460 when the two are
// already friends, which is reported as alreadyFriends=true and counts as
// success so re-binding (and the friend backfill) stays idempotent.
func (c *rongcloudAPIClient) addFriend(ctx context.Context, userID, friendID, remark string) (alreadyFriends bool, err error) {
	return c.addFriendWithOptType(ctx, userID, friendID, remark, friendOptTypeDirect)
}

// addFriendWithOptType is addFriend with the optType spelled out, so the
// friend command channel can forward the client's choice (1 = ask for
// approval, 2 = direct add). Callers that don't care keep using addFriend,
// whose default stays 2 — every existing binding path must keep adding
// directly, otherwise re-binding suddenly needs an approval nobody can grant.
//
// An alreadyFriends result only makes sense for optType=2: with optType=1 the
// edge is not created by this call, so 25460 can only mean the two are already
// friends from before.
//
// 这是 addFriendDetailed 的薄封装，两返回值语义与加三态之前逐字一致：只回答
// 「这对关系本来就在吗」。「只产生了待同意申请」（processCode=25461）在这里和
// 以前一样看不出来 —— 需要区分它的调用方（friend_request.go 的审批收尾）直接
// 用 addFriendDetailed。
func (c *rongcloudAPIClient) addFriendWithOptType(ctx context.Context, userID, friendID, remark, optType string) (alreadyFriends bool, err error) {
	outcome, err := c.addFriendDetailed(ctx, userID, friendID, remark, optType)
	if err != nil {
		return false, err
	}
	return outcome == friendAddExisting, nil
}

// addFriendDetailed 是 /friend/add.json 的三态版本：建上了 / 本来就是好友 /
// 只产生了待同意申请。
//
// 关键差别在 200 响应体的 processCode：只看顶层 code 的话，25461（待对方同意）
// 和真正建好边完全同形，调用方会把「只发出去一条申请」当成「边建好了」。
//
// 报错时返回 friendAddUnknown + error，调用方必须先看 error 再读 outcome。
func (c *rongcloudAPIClient) addFriendDetailed(ctx context.Context, userID, friendID, remark, optType string) (friendAddOutcome, error) {
	if optType != friendOptTypeRequest && optType != friendOptTypeDirect {
		return friendAddUnknown, fmt.Errorf("rongcloud: unsupported friend optType %q", optType)
	}
	form := url.Values{
		"userId":   {userID},
		"targetId": {friendID},
		"optType":  {optType},
	}
	if remark != "" {
		form.Set("name", remark)
	}
	result, err := c.postForm(ctx, "/friend/add.json", form)
	if err != nil {
		// 顶层 code=25460：已经是好友。postForm 把它归成业务错误，但这里要按
		// 「边存在」处理（幂等重绑、先私下同意再补批都走这条）。
		if code, _, ok := RongCloudAPIError(err); ok && code == friendCodeAlreadyFriends {
			return friendAddExisting, nil
		}
		return friendAddUnknown, err
	}
	if processCode, ok := result["processCode"].(float64); ok {
		switch int(processCode) {
		case friendCodePendingApproval:
			// 200 + 25461：申请建立了，边没有。审批链路最容易在这里假成功。
			return friendAddPending, nil
		case friendCodeAlreadyFriends:
			// 200 + 25460：对方免验证，这次直接成了好友（边存在，但没有申请）。
			return friendAddExisting, nil
		}
	}
	return friendAddLinked, nil
}

// friendEntry is one entry from the RongCloud friend list.
type friendEntry struct {
	UserID      string
	Name        string
	PortraitURI string
}

// getFriends fetches a user's RongCloud friend list. RongCloud nests the
// entries under "friendList"; the legacy Python backend also tolerated "data"
// and "users", so accept those shapes too.
func (c *rongcloudAPIClient) getFriends(ctx context.Context, userID string) ([]friendEntry, error) {
	form := url.Values{"userId": {userID}}
	result, err := c.postForm(ctx, "/friend/get.json", form)
	if err != nil {
		return nil, err
	}
	raw, ok := result["friendList"].([]interface{})
	if !ok {
		if raw, ok = result["data"].([]interface{}); !ok {
			raw, _ = result["users"].([]interface{})
		}
	}
	friends := make([]friendEntry, 0, len(raw))
	for _, item := range raw {
		entry, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		id := getString(entry, "userId")
		if id == "" {
			id = getString(entry, "id")
		}
		if id == "" {
			id = getString(entry, "friendId")
		}
		if id == "" {
			continue
		}
		friends = append(friends, friendEntry{
			UserID:      id,
			Name:        getString(entry, "name"),
			PortraitURI: getString(entry, "portraitUri"),
		})
	}
	return friends, nil
}

// getUserInfo retrieves a user's info from RongCloud.
//
// 响应有两种形状，**必须都收**：
//
//	{"code":200,"data":{"userId":"u1","name":"Alice","portraitUri":"http://..."}}
//	{"code":200,"userName":"Alice","userPortrait":"http://...","createTime":"..."}
//
// 前者是线上实际返回（字段包在 data 子字典里）—— 旧 Python 后端的命令通道就是
// 按 `result["data"]["portraitUri"]` 读的，注释见
// clawmessenger-server/rongcloud/command_handler.py:1973；后者是官方英文文档
// （platform-chat-api/user/get）给出的扁平结构，且字段名是 userName / userPortrait。
//
// 之前这里只认扁平 `name` / `portraitUri`，两种形状都对不上：postForm 只看
// `code`，200 就返回成功，于是 getUserInfo 会**静默**回一个空名字 + 空头像，
// 调用方拿不到任何错误信号。它在 2026-10-29 之前没有任何生产调用点（只有
// rongcloud_test.go 里一个扁平 mock），所以这个错位一直没暴露；搜索回填接上
// 来之后就是「永远补不到东西」的哑故障，因此在这里一次性收口。
//
// userId 只在老结构里回传，没回就退回入参 —— 调用方关心的是「这次问的是谁」。
func (c *rongcloudAPIClient) getUserInfo(ctx context.Context, userID string) (userInfoResult, error) {
	form := url.Values{"userId": {userID}}
	result, err := c.postForm(ctx, "/user/info.json", form)
	if err != nil {
		return userInfoResult{}, err
	}
	// 优先 data 子字典；它是空对象或不是对象时退回顶层，两种形状共用下面的取值。
	fields := result
	if data, ok := result["data"].(map[string]interface{}); ok && len(data) > 0 {
		fields = data
	}
	info := userInfoResult{
		UserID:      getStringAny(fields, "userId"),
		Name:        getStringAny(fields, "name", "userName"),
		PortraitURI: getStringAny(fields, "portraitUri", "userPortrait"),
	}
	if info.UserID == "" {
		info.UserID = userID
	}
	return info, nil
}

// RemoveFriends deletes the friend edges from userID to targetIDs.
//
// The endpoint replaces the whole target set it is given, so passing an empty
// list is a no-op rather than a "delete everything". RongCloud's hosted friend
// service counts one call per target, and caps a single request at 100.
func (c *rongcloudAPIClient) RemoveFriends(ctx context.Context, userID string, targetIDs ...string) error {
	if len(targetIDs) == 0 {
		return nil
	}
	form := url.Values{
		"userId":    {userID},
		"targetIds": {strings.Join(targetIDs, ",")},
	}
	_, err := c.postForm(ctx, "/friend/delete.json", form)
	return err
}

// FriendIDs returns the ids in a user's RongCloud friend list.
func (c *rongcloudAPIClient) FriendIDs(ctx context.Context, userID string) ([]string, error) {
	friends, err := c.getFriends(ctx, userID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(friends))
	for _, f := range friends {
		ids = append(ids, f.UserID)
	}
	return ids, nil
}

// DeactivateUser permanently deletes the given users' RongCloud data.
//
// RongCloud drops the profile, message history, conversations and push
// registrations; the user id can only be reactivated empty, so this cannot be
// undone. It is offered separately from the local row cleanup for that reason,
// and callers must gate it behind an explicit opt-in.
func (c *rongcloudAPIClient) DeactivateUser(ctx context.Context, userIDs ...string) error {
	if len(userIDs) == 0 {
		return nil
	}
	form := url.Values{"userId": {strings.Join(userIDs, ",")}}
	_, err := c.postForm(ctx, "/user/deactivate.json", form)
	return err
}
