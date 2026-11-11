package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/integrations/rongcloud"
)

// 目录接口的「最近一次成功目录」缓存：解决的是「四跳链路每次进页面都要重赌一遍」
// 的问题 —— 服务端窗口一旦短于设备枚举时间，用户看到的就是反复 503 超时。
// 这几条用例把三条出口钉死：首屏命中缓存、设备失败时旧值回退、强制刷新绕过缓存。

func testCatalogProviders() rongcloud.DiscussionModelCatalog {
	return rongcloud.DiscussionModelCatalog{
		DefaultModel: "openai/gpt-5.6-sol",
		Providers: []rongcloud.DiscussionModelProvider{{
			ID:   "openai",
			Name: "OpenAI",
			Models: []rongcloud.DiscussionModelEntry{
				{ID: "gpt-5.6-sol", Name: "GPT-5.6"},
			},
		}},
	}
}

func TestClawAdminCatalogCacheFreshStaleAndExpiry(t *testing.T) {
	clawAdminCatalogLastGood.resetForTest()
	t.Cleanup(clawAdminCatalogLastGood.resetForTest)

	now := time.Now()
	const nodeID = "cache-unit-node"

	// 空目录不进缓存：设备答了「一个模型都没有」多半是配置异常，不能被固化 24h。
	clawAdminCatalogLastGood.put(nodeID, rongcloud.DiscussionModelCatalog{}, now)
	if _, _, ok := clawAdminCatalogLastGood.get(nodeID, now, clawAdminCatalogFreshTTL); ok {
		t.Fatal("empty catalog must not be cached")
	}

	clawAdminCatalogLastGood.put(nodeID, testCatalogProviders(), now)
	got, at, ok := clawAdminCatalogLastGood.get(nodeID, now, clawAdminCatalogFreshTTL)
	if !ok || len(got.Providers) != 1 || !at.Equal(now) {
		t.Fatalf("fresh lookup = (%v, %v, %v), want one provider at now", got, at, ok)
	}
	// 返回的是副本：调用方改 provider 切片不能污染缓存。
	got.Providers[0].ID = "mutated"
	again, _, _ := clawAdminCatalogLastGood.get(nodeID, now, clawAdminCatalogFreshTTL)
	if again.Providers[0].ID != "openai" {
		t.Fatalf("cache returned shared slice: provider id = %q", again.Providers[0].ID)
	}

	if _, _, ok := clawAdminCatalogLastGood.get(nodeID, now.Add(clawAdminCatalogFreshTTL+time.Second), clawAdminCatalogFreshTTL); ok {
		t.Fatal("entry past fresh TTL must be a miss")
	}
	if _, _, ok := clawAdminCatalogLastGood.get(nodeID, now.Add(clawAdminCatalogFreshTTL+time.Second), clawAdminCatalogStaleTTL); !ok {
		t.Fatal("entry within stale TTL must still be servable as fallback")
	}
	if _, _, ok := clawAdminCatalogLastGood.get(nodeID, now.Add(clawAdminCatalogStaleTTL+time.Second), clawAdminCatalogStaleTTL); ok {
		t.Fatal("entry past stale TTL must be dropped")
	}
	// 时钟回拨不能把一份旧目录永久判成「刚刚取的」。
	if _, _, ok := clawAdminCatalogLastGood.get(nodeID, now.Add(-time.Hour), clawAdminCatalogFreshTTL); ok {
		t.Fatal("clock skew backwards must be treated as a miss")
	}
}

func TestClawAdminDiscussionHostModelCatalogServesCacheOnSecondCall(t *testing.T) {
	clawAdminCatalogLastGood.resetForTest()
	t.Cleanup(clawAdminCatalogLastGood.resetForTest)

	f := setupDiscussionHostFixture(t, switchableCatalogProviders)
	first := f.catalog(t, f.token, f.nodeUUID)
	if first.Code != http.StatusOK {
		t.Fatalf("first catalog = %d (%s)", first.Code, first.Body.String())
	}
	if source := dataOf(t, first)["source"]; source != "device" {
		t.Fatalf("first source = %v, want device", source)
	}
	if got := atomic.LoadInt32(f.sendCount); got != 1 {
		t.Fatalf("first call sent %d device round trips, want 1", got)
	}

	second := f.catalog(t, f.token, f.nodeUUID)
	if second.Code != http.StatusOK {
		t.Fatalf("second catalog = %d (%s)", second.Code, second.Body.String())
	}
	if source := dataOf(t, second)["source"]; source != "cache" {
		t.Fatalf("second source = %v, want cache", source)
	}
	if got := atomic.LoadInt32(f.sendCount); got != 1 {
		t.Fatalf("cache hit still sent a device round trip (total %d)", got)
	}
}

func TestClawAdminDiscussionHostModelCatalogRefreshBypassesCache(t *testing.T) {
	clawAdminCatalogLastGood.resetForTest()
	t.Cleanup(clawAdminCatalogLastGood.resetForTest)

	f := setupDiscussionHostFixture(t, switchableCatalogProviders)
	if rr := f.catalog(t, f.token, f.nodeUUID); rr.Code != http.StatusOK {
		t.Fatalf("warm-up catalog = %d (%s)", rr.Code, rr.Body.String())
	}

	req := httptest.NewRequest(http.MethodGet,
		"/api/admin/system/discussion-host/model-catalog?node_id="+f.nodeUUID+"&refresh=1", nil)
	req.Header.Set("Authorization", "Bearer "+f.token)
	rr := httptest.NewRecorder()
	f.h.ClawAdminDiscussionHostModelCatalog(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("refresh catalog = %d (%s)", rr.Code, rr.Body.String())
	}
	if source := dataOf(t, rr)["source"]; source != "device" {
		t.Fatalf("refresh source = %v, want device (must not be served from cache)", source)
	}
	if got := atomic.LoadInt32(f.sendCount); got != 2 {
		t.Fatalf("refresh did not reach the device (total %d round trips)", got)
	}
}

func TestClawAdminDiscussionHostModelCatalogFallsBackToStaleCatalog(t *testing.T) {
	clawAdminCatalogLastGood.resetForTest()
	t.Cleanup(clawAdminCatalogLastGood.resetForTest)

	f := setupDiscussionHostFixture(t, switchableCatalogProviders)
	if rr := f.catalog(t, f.token, f.nodeUUID); rr.Code != http.StatusOK {
		t.Fatalf("warm-up catalog = %d (%s)", rr.Code, rr.Body.String())
	}
	// 让这份目录越过 5 分钟新鲜窗口、但仍落在 24 小时回退窗口内：否则首屏
	// 缓存命中会先返回 source=cache，根本轮不到「设备失败」这条分支。
	clawAdminCatalogLastGood.backdateForTest(
		f.nodeUUID, time.Now().Add(-clawAdminCatalogFreshTTL-time.Minute))
	// 模拟「设备这次没答上来」：broker 未装配会立刻回 HOST_OFFLINE，不必真等 50s。
	f.h.RongCloudNodeRequests = nil

	rr := f.catalog(t, f.token, f.nodeUUID)
	if rr.Code != http.StatusOK {
		t.Fatalf("fallback catalog = %d (%s), want 200 with stale data", rr.Code, rr.Body.String())
	}
	if source := dataOf(t, rr)["source"]; source != "cache_stale" {
		t.Fatalf("fallback source = %v, want cache_stale", source)
	}
	providers, ok := dataOf(t, rr)["providers"].([]interface{})
	if !ok || len(providers) == 0 {
		t.Fatalf("fallback providers = %v, want a usable list", dataOf(t, rr)["providers"])
	}

	// 「重新检测」是明确要看设备当下状态的动作，旧目录不能冒充成功。
	req := httptest.NewRequest(http.MethodGet,
		"/api/admin/system/discussion-host/model-catalog?node_id="+f.nodeUUID+"&refresh=1", nil)
	req.Header.Set("Authorization", "Bearer "+f.token)
	forced := httptest.NewRecorder()
	f.h.ClawAdminDiscussionHostModelCatalog(forced, req)
	if forced.Code != http.StatusServiceUnavailable {
		t.Fatalf("forced refresh = %d (%s), want 503 with the folded code", forced.Code, forced.Body.String())
	}
	if !strings.Contains(forced.Body.String(), rongcloud.NodeRequestCodeCatalogUnavailable) {
		t.Fatalf("forced refresh body = %s", forced.Body.String())
	}
}
