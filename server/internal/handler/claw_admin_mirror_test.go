package handler

// claw_admin_mirror_test.go —— 升级包镜像管理接口的测试。
//
// 覆盖四件事：
//  1. 未配置 CLAW_MIRROR_DIR 时整个功能 fail-closed（503 / configured=false）；
//  2. 上传：整包 + SHA256SUMS 一致 → 切换成功、VERSION / latest-release.json
//     都按约定落盘；哈希不符或缺资产 → 400 且现有镜像**原封不动**；
//  3. 二次上传：上一代进 prev（回滚保障）；
//  4. 从 GitHub 拉取：假 GitHub（httptest）驱动完整任务流，含「上传与拉取互斥」。
//
// 假 DB 复用 conversations 测试的 convFakeDB / newConvHandler / convRequest：
// 镜像接口不碰库，只是鉴权链路（loadClawAdmin）要一条 admin 行。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// mirrorContent 生成第 i 个资产的假内容（每个资产内容不同，哈希才不会串）。
func mirrorContent(i int) []byte {
	return []byte(fmt.Sprintf("fake-asset-%d\n%s\n", i, strings.Repeat("x", i+8)))
}

// mirrorFixture 按 clawMirrorRequiredAssets 的顺序生成一整包：内容、SHA256SUMS 文本。
func mirrorFixture() (files map[string][]byte, sums string) {
	files = make(map[string][]byte)
	lines := make([]string, 0, len(clawMirrorRequiredAssets)-1)
	for i, name := range clawMirrorRequiredAssets {
		if name == "SHA256SUMS" {
			continue
		}
		content := mirrorContent(i)
		files[name] = content
		digest := sha256.Sum256(content)
		lines = append(lines, hex.EncodeToString(digest[:])+"  "+name)
	}
	files["SHA256SUMS"] = []byte(strings.Join(lines, "\n") + "\n")
	return files, strings.Join(lines, "\n")
}

// mirrorUploadRequest 把 files 按 "files" 字段打包成 multipart，form 附在表单里。
func mirrorUploadRequest(t *testing.T, files map[string][]byte, form map[string]string) *http.Request {
	t.Helper()
	body := &strings.Builder{}
	writer := newMirrorMultipartWriter(body)
	// 先按固定顺序发必需资产，再把多余的 key（缺资产用/白名单外文件用）补发。
	sent := map[string]bool{}
	for _, name := range clawMirrorRequiredAssets {
		content, ok := files[name]
		if !ok {
			continue // 刻意缺资产用
		}
		writer.writeFile(t, "files", name, content)
		sent[name] = true
	}
	extra := make([]string, 0, len(files))
	for name := range files {
		if !sent[name] {
			extra = append(extra, name)
		}
	}
	sort.Strings(extra)
	for _, name := range extra {
		writer.writeFile(t, "files", name, files[name])
	}
	for key, value := range form {
		writer.writeField(key, value)
	}
	if err := writer.close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req := convRequest(t, http.MethodPost, "/api/admin/claw-mirror/upload", body.String(),
		[]string{"system:write"})
	req.Header.Set("Content-Type", writer.contentType())
	return req
}

func mirrorSetEnv(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CLAW_MIRROR_DIR", dir)
	t.Setenv("CLAW_MIRROR_PUBLIC_BASE", "https://mirror.example.test/claw-web/dl")
	return dir
}

func mirrorReset(t *testing.T) {
	t.Helper()
	clawMirrorResetForTest()
	t.Cleanup(clawMirrorResetForTest)
}

func TestClawAdminMirrorStatusNotConfigured(t *testing.T) {
	t.Setenv("CLAW_MIRROR_DIR", "")
	h := newConvHandler(&convFakeDB{}, []string{"system:read"})

	rr := httptest.NewRecorder()
	h.ClawAdminGetMirrorStatus(rr, convRequest(t, http.MethodGet, "/api/admin/claw-mirror", "", []string{"system:read"}))

	body := decodeConv(t, rr)
	if body["code"] != float64(0) {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	data := body["data"].(map[string]interface{})
	if data["configured"] != false {
		t.Fatalf("configured = %v, want false", data["configured"])
	}
}

func TestClawAdminMirrorStatusWithoutPermission(t *testing.T) {
	mirrorSetEnv(t)
	h := newConvHandler(&convFakeDB{}, []string{"stats:read"})

	rr := httptest.NewRecorder()
	h.ClawAdminGetMirrorStatus(rr, convRequest(t, http.MethodGet, "/api/admin/claw-mirror", "", []string{"stats:read"}))

	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rr.Code)
	}
}

func TestClawAdminMirrorUploadActivates(t *testing.T) {
	mirrorSetEnv(t)
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:read", "system:write"})
	files, _ := mirrorFixture()

	rr := httptest.NewRecorder()
	h.ClawAdminUploadMirror(rr, mirrorUploadRequest(t, files, map[string]string{"tag": "agentsbb-v9.9.9"}))

	body := decodeConv(t, rr)
	if body["code"] != float64(0) {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	dir := clawMirrorDir()

	// latest/：VERSION 与全部资产就位。
	versionRaw, err := os.ReadFile(filepath.Join(dir, "latest", "VERSION"))
	if err != nil || strings.TrimSpace(string(versionRaw)) != "agentsbb-v9.9.9" {
		t.Fatalf("latest/VERSION = %q, err = %v", versionRaw, err)
	}
	for _, name := range clawMirrorRequiredAssets {
		if _, err := os.Stat(filepath.Join(dir, "latest", name)); err != nil {
			t.Fatalf("latest/%s 缺失: %v", name, err)
		}
	}
	// 第一次切换没有上一代。
	if _, err := os.Stat(filepath.Join(dir, "prev")); !os.IsNotExist(err) {
		t.Fatalf("prev 不应存在（首次切换），err = %v", err)
	}
	// latest-release.json：tag 与对外 URL 都对。
	manifestRaw, err := os.ReadFile(filepath.Join(dir, "latest-release.json"))
	if err != nil {
		t.Fatalf("读 latest-release.json: %v", err)
	}
	var manifest struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
			Digest             string `json:"digest"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		t.Fatalf("latest-release.json 不是合法 JSON: %v", err)
	}
	if manifest.TagName != "agentsbb-v9.9.9" {
		t.Fatalf("tag_name = %q", manifest.TagName)
	}
	urlByAsset := map[string]string{}
	for _, asset := range manifest.Assets {
		urlByAsset[asset.Name] = asset.BrowserDownloadURL
	}
	if got := urlByAsset["agentsbb-windows-x64.exe"]; got != "https://mirror.example.test/claw-web/dl/latest/agentsbb-windows-x64.exe" {
		t.Fatalf("windows 资产 URL = %q", got)
	}
	// 状态接口能看到刚切换的版本且校验通过。
	rr2 := httptest.NewRecorder()
	h.ClawAdminGetMirrorStatus(rr2, convRequest(t, http.MethodGet, "/api/admin/claw-mirror", "", []string{"system:read"}))
	status := decodeConv(t, rr2)["data"].(map[string]interface{})
	current := status["current"].(map[string]interface{})
	if current["tag"] != "agentsbb-v9.9.9" || current["manifest_tag"] != "agentsbb-v9.9.9" {
		t.Fatalf("current tag = %v / manifest_tag = %v", current["tag"], current["manifest_tag"])
	}
	if current["verified"] != true {
		t.Fatalf("current.verified = %v, want true", current["verified"])
	}
}

func TestClawAdminMirrorUploadKeepsPreviousAsPrev(t *testing.T) {
	mirrorSetEnv(t)
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:write"})
	files, _ := mirrorFixture()

	for _, tag := range []string{"agentsbb-v9.9.8", "agentsbb-v9.9.9"} {
		rr := httptest.NewRecorder()
		h.ClawAdminUploadMirror(rr, mirrorUploadRequest(t, files, map[string]string{"tag": tag}))
		if body := decodeConv(t, rr); body["code"] != float64(0) {
			t.Fatalf("upload %s: %s", tag, rr.Body.String())
		}
	}
	dir := clawMirrorDir()
	prevVersion, err := os.ReadFile(filepath.Join(dir, "prev", "VERSION"))
	if err != nil || strings.TrimSpace(string(prevVersion)) != "agentsbb-v9.9.8" {
		t.Fatalf("prev/VERSION = %q, err = %v（上一代应保留在 prev）", prevVersion, err)
	}
}

func TestClawAdminMirrorUploadRejectsHashMismatch(t *testing.T) {
	mirrorSetEnv(t)
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:write"})
	files, _ := mirrorFixture()
	// 篡改一个资产的内容：哈希立刻对不上 SHA256SUMS。
	files["agentsbb-linux-x64"] = append(files["agentsbb-linux-x64"], 'B', 'A', 'D')

	rr := httptest.NewRecorder()
	h.ClawAdminUploadMirror(rr, mirrorUploadRequest(t, files, map[string]string{"tag": "agentsbb-v9.9.9"}))

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "校验未通过") {
		t.Fatalf("报错没有点明校验失败: %s", rr.Body.String())
	}
	// 现有镜像不动：目录都不该被建出来（上传前没有 latest）。
	if _, err := os.Stat(filepath.Join(clawMirrorDir(), "latest")); !os.IsNotExist(err) {
		t.Fatalf("校验失败后 latest 不应存在, err = %v", err)
	}
}

func TestClawAdminMirrorUploadRejectsMissingAsset(t *testing.T) {
	mirrorSetEnv(t)
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:write"})
	files, _ := mirrorFixture()
	delete(files, "agentsbb-darwin-arm64")

	rr := httptest.NewRecorder()
	h.ClawAdminUploadMirror(rr, mirrorUploadRequest(t, files, map[string]string{"tag": "agentsbb-v9.9.9"}))

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "agentsbb-darwin-arm64") {
		t.Fatalf("报错没有点名缺失的资产: %s", rr.Body.String())
	}
}

func TestClawAdminMirrorUploadRejectsForeignFilename(t *testing.T) {
	mirrorSetEnv(t)
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:write"})
	files, _ := mirrorFixture()
	files["../evil.sh"] = []byte("pwn")

	rr := httptest.NewRecorder()
	h.ClawAdminUploadMirror(rr, mirrorUploadRequest(t, files, map[string]string{"tag": "agentsbb-v9.9.9"}))

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rr.Code, rr.Body.String())
	}
	if _, err := os.Stat(filepath.Join(clawMirrorDir(), "latest")); !os.IsNotExist(err) {
		t.Fatalf("白名单外的文件被落盘了: err = %v", err)
	}
}

func TestClawAdminMirrorUploadRequiresTag(t *testing.T) {
	mirrorSetEnv(t)
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:write"})
	files, _ := mirrorFixture()

	rr := httptest.NewRecorder()
	h.ClawAdminUploadMirror(rr, mirrorUploadRequest(t, files, nil))

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "版本号") {
		t.Fatalf("报错没有说明版本号问题: %s", rr.Body.String())
	}
}

func TestClawAdminMirrorUploadAcceptsVersionForm(t *testing.T) {
	mirrorSetEnv(t)
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:write"})
	files, _ := mirrorFixture()

	rr := httptest.NewRecorder()
	h.ClawAdminUploadMirror(rr, mirrorUploadRequest(t, files, map[string]string{"version": "1.2.3"}))

	body := decodeConv(t, rr)
	if body["code"] != float64(0) {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	versionRaw, _ := os.ReadFile(filepath.Join(clawMirrorDir(), "latest", "VERSION"))
	if strings.TrimSpace(string(versionRaw)) != "agentsbb-v1.2.3" {
		t.Fatalf("latest/VERSION = %q", versionRaw)
	}
}

// mirrorFakeGitHub 起一个假的 GitHub Releases 上游：releases/latest 返回带
// browser_download_url 的资产清单，/dl/<name> 按字节回包。返回服务器与关闭钩子。
func mirrorFakeGitHub(t *testing.T, gate chan struct{}) *httptest.Server {
	t.Helper()
	files, _ := mirrorFixture()
	tag := "agentsbb-v9.8.7"
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/repos/clawmessenger/claw-messenger/releases/latest":
			type asset struct {
				Name               string `json:"name"`
				BrowserDownloadURL string `json:"browser_download_url"`
				Digest             string `json:"digest"`
			}
			assets := make([]asset, 0, len(files))
			for name, content := range files {
				digest := sha256.Sum256(content)
				assets = append(assets, asset{
					Name:               name,
					BrowserDownloadURL: "http://" + r.Host + "/dl/" + name,
					Digest:             "sha256:" + hex.EncodeToString(digest[:]),
				})
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"tag_name": tag, "assets": assets})
		case strings.HasPrefix(r.URL.Path, "/dl/"):
			if gate != nil {
				<-gate // 挂住下载，制造「任务正在跑」的窗口
			}
			name := strings.TrimPrefix(r.URL.Path, "/dl/")
			_, _ = w.Write(files[name])
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(ts.Close)
	return ts
}

func mirrorWaitJob(t *testing.T, want string) clawMirrorJobState {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		job := clawMirror.snapshot()
		if job.State == want {
			return job
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("任务 10s 内未到达 %s： %+v", want, clawMirror.snapshot())
	return clawMirrorJobState{}
}

func TestClawAdminMirrorPullFromGitHubActivates(t *testing.T) {
	ts := mirrorFakeGitHub(t, nil)
	t.Setenv("CLAW_UPGRADE_RELEASE_API", ts.URL)
	t.Cleanup(clawUpgradeResetCacheForTest)
	clawUpgradeResetCacheForTest()
	dir := mirrorSetEnv(t)
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:write"})

	rr := httptest.NewRecorder()
	h.ClawAdminPullMirrorFromGitHub(rr, convRequest(t, http.MethodPost, "/api/admin/claw-mirror/pull-github", "", []string{"system:write"}))

	if body := decodeConv(t, rr); body["code"] != float64(0) {
		t.Fatalf("pull-github: %s", rr.Body.String())
	}
	job := mirrorWaitJob(t, "succeeded")
	if job.Tag != "agentsbb-v9.8.7" {
		t.Fatalf("job.Tag = %q", job.Tag)
	}
	// 落盘结果与上传路径同一套契约。
	versionRaw, err := os.ReadFile(filepath.Join(dir, "latest", "VERSION"))
	if err != nil || strings.TrimSpace(string(versionRaw)) != "agentsbb-v9.8.7" {
		t.Fatalf("latest/VERSION = %q, err = %v", versionRaw, err)
	}
	manifestRaw, err := os.ReadFile(filepath.Join(dir, "latest-release.json"))
	if err != nil {
		t.Fatalf("读 latest-release.json: %v", err)
	}
	if !strings.Contains(string(manifestRaw), "agentsbb-v9.8.7") {
		t.Fatalf("latest-release.json 里没有新 tag: %s", manifestRaw)
	}
}

func TestClawAdminMirrorUploadConflictsWithRunningPull(t *testing.T) {
	gate := make(chan struct{})
	ts := mirrorFakeGitHub(t, gate)
	t.Setenv("CLAW_UPGRADE_RELEASE_API", ts.URL)
	t.Cleanup(clawUpgradeResetCacheForTest)
	clawUpgradeResetCacheForTest()
	mirrorSetEnv(t)
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:write"})

	rr := httptest.NewRecorder()
	h.ClawAdminPullMirrorFromGitHub(rr, convRequest(t, http.MethodPost, "/api/admin/claw-mirror/pull-github", "", []string{"system:write"}))
	if body := decodeConv(t, rr); body["code"] != float64(0) {
		t.Fatalf("pull-github: %s", rr.Body.String())
	}
	mirrorWaitJob(t, "running")

	files, _ := mirrorFixture()
	rr2 := httptest.NewRecorder()
	h.ClawAdminUploadMirror(rr2, mirrorUploadRequest(t, files, map[string]string{"tag": "agentsbb-v9.9.9"}))
	if rr2.Code != http.StatusConflict {
		t.Fatalf("上传应与进行中的拉取冲突（409），got %d: %s", rr2.Code, rr2.Body.String())
	}

	rr3 := httptest.NewRecorder()
	h.ClawAdminUploadMirror(rr3, mirrorUploadRequest(t, files, map[string]string{"tag": "agentsbb-v9.9.9"}))
	if rr3.Code != http.StatusConflict {
		t.Fatalf("重复上传也应 409, got %d", rr3.Code)
	}

	close(gate) // 放行下载，让任务收尾，别把 busy 槽留给下一个用例
	mirrorWaitJob(t, "succeeded")
}

func TestClawAdminMirrorPullRequiresMirrorDir(t *testing.T) {
	t.Setenv("CLAW_MIRROR_DIR", "")
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:write"})

	rr := httptest.NewRecorder()
	h.ClawAdminPullMirrorFromGitHub(rr, convRequest(t, http.MethodPost, "/api/admin/claw-mirror/pull-github", "", []string{"system:write"}))

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rr.Code)
	}
}

func TestClawAdminMirrorUploadRequiresPublicBase(t *testing.T) {
	mirrorSetEnv(t)
	t.Setenv("CLAW_MIRROR_PUBLIC_BASE", "")
	t.Setenv("CLAW_PUBLIC_BASE_URL", "")
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:write"})
	files, _ := mirrorFixture()

	rr := httptest.NewRecorder()
	h.ClawAdminUploadMirror(rr, mirrorUploadRequest(t, files, map[string]string{"tag": "agentsbb-v9.9.9"}))

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503: %s", rr.Code, rr.Body.String())
	}
}

// ---- 品牌改名过渡期：旧名单整包 ------------------------------------------------

// mirrorLegacyFixture 生成一份**改名前**的镜像包：文件名全是 clawmessenger-*，
// SHA256SUMS 里的条目也跟着是旧名。管理员手里的存量镜像包就长这样。
func mirrorLegacyFixture() map[string][]byte {
	files, _ := mirrorFixture()
	out := make(map[string][]byte, len(files))
	renamed := make([]string, 0, len(files))
	for name, content := range files {
		legacy := clawMirrorLegacyName(name)
		if legacy == "" {
			legacy = name // SHA256SUMS 之类与品牌无关
		}
		out[legacy] = content
		if name != "SHA256SUMS" {
			renamed = append(renamed, legacy)
		}
	}
	// SHA256SUMS 要按旧名重算一遍，否则校验阶段会报「清单里没有它的条目」。
	sort.Strings(renamed)
	lines := make([]string, 0, len(renamed))
	for _, name := range renamed {
		digest := sha256.Sum256(out[name])
		lines = append(lines, hex.EncodeToString(digest[:])+"  "+name)
	}
	out["SHA256SUMS"] = []byte(strings.Join(lines, "\n") + "\n")
	return out
}

// TestClawAdminMirrorUploadAcceptsLegacyAssetNames 保证改名窗口内后台上传不 400：
// 存量工具打出来的包只有旧名，而它往往正是「必须能发版」的那一刻。
func TestClawAdminMirrorUploadAcceptsLegacyAssetNames(t *testing.T) {
	mirrorSetEnv(t)
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:write"})
	files := mirrorLegacyFixture()

	rr := httptest.NewRecorder()
	h.ClawAdminUploadMirror(rr, mirrorUploadRequest(t, files, map[string]string{"tag": "clawmessenger-v9.9.9"}))

	body := decodeConv(t, rr)
	if body["code"] != float64(0) {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	dir := clawMirrorDir()
	// 资产按上传时的旧名落盘（镜像里有什么名字就该能下到什么名字）。
	for _, name := range clawMirrorLegacyAssets {
		if _, err := os.Stat(filepath.Join(dir, "latest", name)); err != nil {
			t.Fatalf("latest/%s 缺失: %v", name, err)
		}
	}
	// VERSION 归一成新前缀：两个前缀客户端都认，新前缀是目标态。
	versionRaw, err := os.ReadFile(filepath.Join(dir, "latest", "VERSION"))
	if err != nil || strings.TrimSpace(string(versionRaw)) != "agentsbb-v9.9.9" {
		t.Fatalf("latest/VERSION = %q, err = %v", versionRaw, err)
	}
	// latest-release.json 只列真实存在的资产：旧包没有新名，就不该凭空列出来。
	manifestRaw, err := os.ReadFile(filepath.Join(dir, "latest-release.json"))
	if err != nil {
		t.Fatalf("读 latest-release.json: %v", err)
	}
	var manifest struct {
		Assets []struct {
			Name string `json:"name"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		t.Fatalf("latest-release.json 不是合法 JSON: %v", err)
	}
	listed := map[string]bool{}
	for _, asset := range manifest.Assets {
		listed[asset.Name] = true
	}
	for _, name := range clawMirrorLegacyAssets {
		if !listed[name] {
			t.Fatalf("清单里缺 %s（本镜像里真实存在的资产都要列）", name)
		}
	}
	for _, name := range clawMirrorRequiredAssets {
		if name == "SHA256SUMS" {
			continue // 与品牌无关，永远都列
		}
		if listed[name] {
			t.Fatalf("清单里不该出现 %s（这个包只有旧名）", name)
		}
	}
}

// TestClawAdminMirrorUploadRejectsForeignFilenameCrossSet 确认白名单放宽后仍然
// 拒绝「既不是新名也不是旧名」的文件 —— 白名单是安全边界，不是品牌开关。
func TestClawAdminMirrorUploadRejectsForeignFilenameCrossSet(t *testing.T) {
	mirrorSetEnv(t)
	mirrorReset(t)
	h := newConvHandler(&convFakeDB{}, []string{"system:write"})
	files := mirrorLegacyFixture()
	files["agentsbb-evil-x64.exe"] = []byte("pwn")

	rr := httptest.NewRecorder()
	h.ClawAdminUploadMirror(rr, mirrorUploadRequest(t, files, map[string]string{"tag": "agentsbb-v9.9.9"}))

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), "不接受文件") {
		t.Fatalf("报错没有点明白名单: %s", rr.Body.String())
	}
}

// ---- multipart 打桩 ---------------------------------------------------------

// mirrorMultipartWriter 收拢 multipart 构造细节，避免每个用例手写 boundary。
type mirrorMultipartWriter struct {
	builder  *strings.Builder
	boundary string
}

func newMirrorMultipartWriter(builder *strings.Builder) *mirrorMultipartWriter {
	return &mirrorMultipartWriter{builder: builder, boundary: "mirror-test-boundary-7f3a"}
}

func (w *mirrorMultipartWriter) contentType() string {
	return "multipart/form-data; boundary=" + w.boundary
}

func (w *mirrorMultipartWriter) writeField(name, value string) {
	fmt.Fprintf(w.builder, "--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n",
		w.boundary, name, value)
}

func (w *mirrorMultipartWriter) writeFile(t *testing.T, field, name string, content []byte) {
	t.Helper()
	fmt.Fprintf(w.builder, "--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\nContent-Type: application/octet-stream\r\n\r\n",
		w.boundary, field, name)
	w.builder.Write(content)
	w.builder.WriteString("\r\n")
}

func (w *mirrorMultipartWriter) close() error {
	fmt.Fprintf(w.builder, "--%s--\r\n", w.boundary)
	return nil
}
