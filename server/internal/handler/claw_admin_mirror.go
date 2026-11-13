package handler

// 升级包镜像（claw-mirror）的管理端接口 —— 把「服务器上手工跑
// claw-cli-mirror-sync.sh」这件事搬进后台。
//
// 镜像是什么：GitHub Release 里的 CLI 安装包（4 个平台二进制 + 2 个守护脚本
// 压缩包 + SHA256SUMS），落在服务器磁盘上，经 nginx 以 /dl/latest/
// 对外提供，给访问不到 GitHub 的设备当备用下载源。目录布局与同步脚本一致：
//
//	$CLAW_MIRROR_DIR/latest/   当前对外服务的资产（webroot 里的 dl 符号链接指向这里）
//	$CLAW_MIRROR_DIR/prev/     上一代（回滚用）
//	$CLAW_MIRROR_DIR/latest-release.json   GitHub API 兼容格式的版本清单
//
// 两条写路径，共用同一套「先落 staging、逐个校验、再原子切换」的纪律：
//   - POST /upload：管理员把本机下好的包（浏览器直传，字段 files 多选）交给服务端；
//   - POST /pull-github：服务端自己从 GitHub 拉 latest（出不了网的机器这条路会
//     明确报错，走不了就是走不了 —— 这正是上传这条路存在的原因）。
//
// 安全面：文件名白名单（不接受任意名字落盘）、版本号 ^\d+\.\d+\.\d+$（会被拼进
// URL 与 JSON）、逐文件 sha256 对照 SHA256SUMS，校验不过绝不清掉现有 latest。
// 对外 URL 基址由 CLAW_MIRROR_PUBLIC_BASE（缺省 CLAW_PUBLIC_BASE_URL + /dl）
// 提供，写进 latest-release.json。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// clawMirrorDirEnv 指定镜像根目录。未配置 = 本部署不提供镜像功能，
	// 四个端点一起 503 —— 与下载代理的 fail-closed 同一姿态：猜路径比不做事危险。
	clawMirrorDirEnv = "CLAW_MIRROR_DIR"
	// clawMirrorPublicBaseEnv 是对外基址（到 /dl 这一层，不含 /latest）。
	clawMirrorPublicBaseEnv = "CLAW_MIRROR_PUBLIC_BASE"
	// clawPublicBaseEnv 是站点基址的通用 env（branding 也用它），缺省拼接用。
	clawPublicBaseEnv = "CLAW_PUBLIC_BASE_URL"
	// clawMirrorMaxUploadBytes 是一次上传的总预算。六个资产合计 400MB 上下，
	// 留一倍余量；超出会在 ParseMultipartForm 那一层被 MaxBytesReader 掐断。
	clawMirrorMaxUploadBytes = 1 << 30
	// clawMirrorAssetTimeout 是单个资产的下载墙钟。GitHub CDN 慢的时候 90MB
	// 可能要几分钟；30 分钟足够，超了就该报错而不是挂死。
	clawMirrorAssetTimeout = 30 * time.Minute
	// clawMirrorJobTimeout 是整个拉取任务的墙钟上限。
	clawMirrorJobTimeout = 60 * time.Minute
	// clawMirrorFileMode / clawMirrorDirMode 与同步脚本一致：nginx 只需要读。
	clawMirrorFileMode = 0o644
	clawMirrorDirMode  = 0o755
)

// clawMirrorRequiredAssets 是「一个可用版本」的最小资产集：发布矩阵的 4 个平台
// 二进制 + 2 个守护脚本压缩包 + 校验和清单。与 clawUpgradeAssetsByPlatform 同源
// （Windows 一项复用常量），与 agentsbb-cli-mirror-sync.sh 的 DEFAULT_ASSETS 一致。
// 上传与拉取都按这份清单要求齐全 —— 部分激活留给手工脚本（它有 --only），
// 后台按钮只做整包切换，避免「镜像里只有半个平台」这种最难排查的状态。
//
// 这是**新名单**（agentsbb-*）。改名过渡期 Release 里同时存在旧名单
// （clawmessenger-*）的别名资产，见 clawMirrorLegacyAssets。
var clawMirrorRequiredAssets = []string{
	clawUpgradeWindowsAsset,
	"agentsbb-windows-x64-daemon-scripts.zip",
	"agentsbb-linux-x64",
	"agentsbb-linux-arm64",
	"agentsbb-linux-daemon-scripts.tar.gz",
	"agentsbb-darwin-arm64",
	"SHA256SUMS",
}

// clawMirrorAssetPrefix / clawMirrorLegacyAssetPrefix 是两套资产名的前缀。
const (
	clawMirrorAssetPrefix       = "agentsbb-"
	clawMirrorLegacyAssetPrefix = "clawmessenger-"
)

// clawMirrorLegacyName 把新名单里的资产名映射成旧名单的等价名。
// SHA256SUMS / VERSION / MANIFEST 这类与品牌无关的文件返回空串。
func clawMirrorLegacyName(asset string) string {
	if !strings.HasPrefix(asset, clawMirrorAssetPrefix) {
		return ""
	}
	return clawMirrorLegacyAssetPrefix + strings.TrimPrefix(asset, clawMirrorAssetPrefix)
}

// clawMirrorLegacyAssets 是改名前的等价整包（由新名单机械派生，两套不会漂移）。
//
// 为什么后端要认两套：过渡期管理员手里的「镜像包」可能是改名前的工具打的
// （里面是 clawmessenger-*），而 Release 里两种名字都有。整包校验必须能认出来
// 是哪一套，否则升级窗口内后台上传会全量 400 —— 而那正是最需要它可用的时刻。
// TODO(rebrand-retire): 1.3.x 全部升级后删除（连同 Release 里的旧名别名资产）。
var clawMirrorLegacyAssets = func() []string {
	out := make([]string, 0, len(clawMirrorRequiredAssets))
	for _, asset := range clawMirrorRequiredAssets {
		if legacy := clawMirrorLegacyName(asset); legacy != "" {
			out = append(out, legacy)
		}
	}
	return out
}()

// clawMirrorOptionalAssets 是上传时顺带接受、但不参与校验的文件。
var clawMirrorOptionalAssets = []string{"VERSION", "MANIFEST"}

func clawMirrorAllowedNames() map[string]bool {
	allowed := make(map[string]bool, len(clawMirrorRequiredAssets)+len(clawMirrorLegacyAssets)+len(clawMirrorOptionalAssets))
	for _, name := range clawMirrorRequiredAssets {
		allowed[name] = true
	}
	for _, name := range clawMirrorLegacyAssets {
		allowed[name] = true
	}
	for _, name := range clawMirrorOptionalAssets {
		allowed[name] = true
	}
	return allowed
}

// clawMirrorMissingAssets 返回 set 里「present 中不存在」的条目（保序）。
func clawMirrorMissingAssets(present map[string]bool, set []string) []string {
	missing := make([]string, 0, len(set))
	for _, asset := range set {
		if !present[asset] {
			missing = append(missing, asset)
		}
	}
	return missing
}

// clawMirrorPickAssetSet 从「已提供的文件名」里挑出完整的一套名单。
//
// 新名单优先：整包既有新名又有旧名时按新名核对；只有旧名时才认旧名单。
// 返回 (要严格核对的名单, 另一套名单, 是否找到完整一套)。没找到时 chosen 固定是
// 新名单 —— 报错文案要对准目标态，而不是把两套名字混着抛给管理员。
func clawMirrorPickAssetSet(present map[string]bool) (chosen, other []string, ok bool) {
	if len(clawMirrorMissingAssets(present, clawMirrorRequiredAssets)) == 0 {
		return clawMirrorRequiredAssets, clawMirrorLegacyAssets, true
	}
	if len(clawMirrorMissingAssets(present, clawMirrorLegacyAssets)) == 0 {
		return clawMirrorLegacyAssets, clawMirrorRequiredAssets, true
	}
	return clawMirrorRequiredAssets, clawMirrorLegacyAssets, false
}

// clawMirrorDir 返回镜像根目录；未配置返回空串。
func clawMirrorDir() string {
	return strings.TrimSpace(os.Getenv(clawMirrorDirEnv))
}

// clawMirrorPublicBase 推导对外基址（到 /dl 层）。
// 顺序：CLAW_MIRROR_PUBLIC_BASE → CLAW_PUBLIC_BASE_URL + /dl。
// 都没有时返回空串 —— latest-release.json 没有可信的对外地址就不该写，
// 写一份指向错误域名的清单比不写更糟（安装脚本会真的去下）。
func clawMirrorPublicBase() string {
	if v := strings.TrimRight(strings.TrimSpace(os.Getenv(clawMirrorPublicBaseEnv)), "/"); v != "" {
		return v
	}
	if v := strings.TrimRight(strings.TrimSpace(os.Getenv(clawPublicBaseEnv)), "/"); v != "" {
		return v + "/dl"
	}
	return ""
}

// ---- 任务状态 ---------------------------------------------------------------

// clawMirrorJobState 是一次拉取任务的快照。上传是同步请求，不产生任务。
type clawMirrorJobState struct {
	Kind       string     `json:"kind"`
	State      string     `json:"state"` // running | succeeded | failed
	Tag        string     `json:"tag,omitempty"`
	Detail     string     `json:"detail,omitempty"`
	Error      string     `json:"error,omitempty"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

// clawMirrorJobs 是进程级任务状态。同一时刻只允许一个镜像写任务（拉取或上传）：
// 切换语义是「整目录 rename」，两个任务并发切换就是自己制造竞态。
type clawMirrorJobs struct {
	mu   sync.Mutex
	job  clawMirrorJobState
	busy sync.Mutex // 谁持有它，谁就在做镜像写操作（TryLock 探测）
}

var clawMirror = &clawMirrorJobs{}

func clawMirrorResetForTest() {
	clawMirror.mu.Lock()
	clawMirror.job = clawMirrorJobState{}
	clawMirror.mu.Unlock()
}

// startRunning 抢占任务槽：已在跑返回 false。
func (m *clawMirrorJobs) startRunning(kind string) bool {
	if !m.busy.TryLock() {
		return false
	}
	m.mu.Lock()
	m.job = clawMirrorJobState{Kind: kind, State: "running", StartedAt: time.Now()}
	m.mu.Unlock()
	return true
}

// update 在任务运行中刷新进度。state 为空表示沿用当前值。
func (m *clawMirrorJobs) update(tag, detail string) {
	m.mu.Lock()
	if tag != "" {
		m.job.Tag = tag
	}
	if detail != "" {
		m.job.Detail = detail
	}
	m.mu.Unlock()
}

// finish 收尾任务并释放槽。error 非空 = failed。
func (m *clawMirrorJobs) finish(err error) {
	m.mu.Lock()
	now := time.Now()
	m.job.FinishedAt = &now
	if err != nil {
		m.job.State = "failed"
		m.job.Error = err.Error()
	} else {
		m.job.State = "succeeded"
		m.job.Detail = ""
	}
	m.mu.Unlock()
	m.busy.Unlock()
}

func (m *clawMirrorJobs) snapshot() clawMirrorJobState {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.job
}

// ---- GET /api/admin/claw-mirror ---------------------------------------------

// clawMirrorFileReport 是镜像里一个资产的体检结果。
type clawMirrorFileReport struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256,omitempty"`
	OK     bool   `json:"ok"` // 与 SHA256SUMS 一致（清单里没有它的条目也算不 OK）
}

// ClawAdminGetMirrorStatus GET /api/admin/claw-mirror —— 镜像现状 + GitHub 最新版。
//
// GitHub 解析复用升级链路的 10 分钟缓存：这个页面与「下发升级」看的是同一个
// 事实来源，不该各查各的。GitHub 打不通时这里**不报错**——镜像现状照常返回，
// github_latest 里放 error 字段，页面上显示「拿不到最新版」即可。
func (h *Handler) ClawAdminGetMirrorStatus(w http.ResponseWriter, r *http.Request) {
	if h.requireClawAdmin("system:read", w, r) == nil {
		return
	}
	dir := clawMirrorDir()
	if dir == "" {
		clawAdminOK(w, map[string]interface{}{"configured": false})
		return
	}
	status := map[string]interface{}{
		"configured":  true,
		"dir":         dir,
		"public_base": clawMirrorPublicBase(),
		"current":     clawMirrorInspectCurrent(dir),
	}
	// GitHub latest：单独超时，别让页面因为 GitHub 慢转圈 10 秒。
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	release, stale, err := resolveClawUpgradeLatest(ctx)
	if err != nil {
		status["github_latest"] = map[string]interface{}{"error": err.Error()}
	} else {
		status["github_latest"] = map[string]interface{}{
			"version": release.Version,
			"tag":     release.Tag,
			"stale":   stale,
		}
	}
	clawAdminOK(w, status)
}

// clawMirrorInspectCurrent 体检 $DIR/latest：版本、各文件大小与哈希核对结果。
// 目录不存在返回 nil（第一次部署还没同步过，是正常状态不是错误）。
func clawMirrorInspectCurrent(dir string) map[string]interface{} {
	latest := filepath.Join(dir, "latest")
	entries, err := os.ReadDir(latest)
	if err != nil {
		return nil
	}
	sums := map[string]string{}
	if raw, err := os.ReadFile(filepath.Join(latest, "SHA256SUMS")); err == nil {
		sums = parseClawSHA256Sums(string(raw))
	}
	files := make([]clawMirrorFileReport, 0, len(entries))
	allOK := true
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		report := clawMirrorFileReport{Name: entry.Name(), Size: info.Size(), OK: true}
		if entry.Name() != "SHA256SUMS" && entry.Name() != "VERSION" && entry.Name() != "MANIFEST" {
			sum, err := clawMirrorHashFile(filepath.Join(latest, entry.Name()))
			if err == nil {
				report.SHA256 = sum
			}
			// 清单里没有这个资产的条目 = 无法校验 = 不 OK。
			expected, ok := sums[entry.Name()]
			report.OK = err == nil && ok && expected == sum
			if !report.OK {
				allOK = false
			}
		}
		files = append(files, report)
	}
	out := map[string]interface{}{"files": files, "verified": allOK}
	if tagRaw, err := os.ReadFile(filepath.Join(latest, "VERSION")); err == nil {
		out["tag"] = strings.TrimSpace(string(tagRaw))
	}
	// latest-release.json 的 tag_name 一起给：它才是安装脚本真正读的版本声明。
	if raw, err := os.ReadFile(filepath.Join(dir, "latest-release.json")); err == nil {
		var manifest struct {
			TagName string `json:"tag_name"`
		}
		if json.Unmarshal(raw, &manifest) == nil && manifest.TagName != "" {
			out["manifest_tag"] = manifest.TagName
		}
	}
	return out
}

// clawMirrorHashFile 流式算一个文件的 sha256（安装包最大 90MB，别整读进内存）。
func clawMirrorHashFile(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// ---- GET /api/admin/claw-mirror/job ------------------------------------------

// ClawAdminGetMirrorJob GET /api/admin/claw-mirror/job —— 拉取任务进度（前端 2s 轮询）。
func (h *Handler) ClawAdminMirrorJob(w http.ResponseWriter, r *http.Request) {
	if h.requireClawAdmin("system:read", w, r) == nil {
		return
	}
	clawAdminOK(w, map[string]interface{}{"job": clawMirror.snapshot()})
}

// ---- POST /api/admin/claw-mirror/pull-github ---------------------------------

// ClawAdminPullMirrorFromGitHub POST /api/admin/claw-mirror/pull-github ——
// 启动「服务端从 GitHub 拉 latest 并切换镜像」的异步任务。
//
// 为什么异步：6 个资产合计 400MB 级，同步 HTTP 请求必然撞上 nginx 的
// proxy_read_timeout（运维对话当年就为这个改成了轮询）。POST 只负责开任务，
// 进度走 GET /job。已在跑时 409 —— 页面据此提示「正在同步中」。
func (h *Handler) ClawAdminPullMirrorFromGitHub(w http.ResponseWriter, r *http.Request) {
	if h.requireClawAdmin("system:write", w, r) == nil {
		return
	}
	dir := clawMirrorDir()
	if dir == "" {
		clawAdminFail(w, 503, "未配置 "+clawMirrorDirEnv+"，本部署未启用镜像功能")
		return
	}
	base := clawMirrorPublicBase()
	if base == "" {
		clawAdminFail(w, 503, "未配置 "+clawMirrorPublicBaseEnv+"（或 "+clawPublicBaseEnv+"），无法生成 latest-release.json")
		return
	}
	if !clawMirror.startRunning("pull-github") {
		clawAdminFail(w, 409, "已有一个镜像同步任务在进行中")
		return
	}
	// 任务上下文独立于请求：请求返回后任务要继续跑。
	ctx, cancel := context.WithTimeout(context.Background(), clawMirrorJobTimeout)
	go func() {
		defer cancel()
		err := clawMirrorPullFromGitHub(ctx, dir, base)
		clawMirror.finish(err)
		if err != nil {
			slog.Error("claw mirror: 从 GitHub 拉取失败", "error", err)
		}
	}()
	clawAdminOK(w, map[string]interface{}{"job": clawMirror.snapshot()})
}

// clawMirrorPullFromGitHub 是拉取任务的主体：解析 latest → 下载 → 校验 → 切换。
func clawMirrorPullFromGitHub(ctx context.Context, dir, publicBase string) error {
	clawMirror.update("", "解析 GitHub 最新版本")
	release, stale, err := resolveClawUpgradeLatest(ctx)
	if err != nil {
		return fmt.Errorf("解析 GitHub 最新版本失败: %w", err)
	}
	tag := clawUpgradeTagFromVersion(release.Version)
	if strings.TrimSpace(release.Tag) != "" {
		// Release 上的 tag 是权威值：过渡期它可能是旧前缀（clawmessenger-v1.3.33）。
		// 照抄比重新拼更诚实 —— 这个 tag 会原样写进 VERSION 与 latest-release.json
		// 的 tag_name，客户端按它比对版本，两个前缀它都认。
		tag = strings.TrimSpace(release.Tag)
	}
	clawMirror.update(tag, "")
	if stale {
		// 缓存降级时的 latest 可能比真 latest 旧：显式留痕，管理员看到的是
		// 「上次已知版本」而不是被静默降级的假最新。
		slog.Warn("claw mirror: GitHub 解析降级，使用上次缓存的版本", "tag", tag)
	}
	client := clawUpgradeHTTPClient()
	stage, err := os.MkdirTemp(dir, ".incoming-")
	if err != nil {
		return fmt.Errorf("创建暂存目录失败: %w", err)
	}
	defer os.RemoveAll(stage)

	downloaded := map[string]string{}
	for _, asset := range clawMirrorRequiredAssets {
		clawMirror.update("", "下载 "+asset)
		// 资产名先按新名单找，找不到再退回旧名单的等价名：品牌改名后的第一次
		// 发布之前，GitHub 上的 latest 仍然是纯旧名单的 Release。落盘用**实际
		// 拿到的那套名字**，校验阶段会据此挑对应名单。
		assetURL, local := release.Assets[asset], asset
		if assetURL == "" {
			if legacy := clawMirrorLegacyName(asset); legacy != "" && release.Assets[legacy] != "" {
				assetURL, local = release.Assets[legacy], legacy
			}
		}
		// 运维显式配了 CLAW_UPGRADE_RELEASE_WEB（gh 代理）时，构造 URL 优先于
		// GitHub API 返回的 github.com 直链 —— 直链在这类机器上本来就不通。
		if override := clawUpgradeWebBase(); override != "https://github.com" {
			assetURL = clawUpgradeAssetURL(tag, local)
		}
		if assetURL == "" {
			return fmt.Errorf("GitHub Release 里没有资产 %s", asset)
		}
		sum, derr := clawMirrorDownload(ctx, client, assetURL, filepath.Join(stage, local))
		if derr != nil {
			return fmt.Errorf("下载 %s 失败: %w", local, derr)
		}
		downloaded[local] = sum
	}
	if err := clawMirrorVerifyStage(stage, downloaded); err != nil {
		return err
	}
	clawMirror.update("", "校验通过，切换镜像目录")
	if err := clawMirrorActivate(dir, stage, tag); err != nil {
		return err
	}
	return clawMirrorWriteManifest(dir, tag)
}

// clawMirrorDownload 下载 url 到 dst 并返回 sha256。
func clawMirrorDownload(ctx context.Context, client *http.Client, url, dst string) (string, error) {
	dctx, cancel := context.WithTimeout(ctx, clawMirrorAssetTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(dctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", res.StatusCode)
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, clawMirrorFileMode)
	if err != nil {
		return "", err
	}
	digest := sha256.New()
	if _, err := io.Copy(out, io.TeeReader(io.LimitReader(res.Body, 2<<30), digest)); err != nil {
		out.Close()
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// ---- POST /api/admin/claw-mirror/upload ---------------------------------------

// ClawAdminUploadMirror POST /api/admin/claw-mirror/upload —— 浏览器直传安装包，
// 服务端校验后切换镜像。同步请求：上传本身（400MB 级）就是这个请求的耗时主体，
// 校验是磁盘上的哈希运算（秒级），不再拆任务。部署侧需要保证 nginx 的
// client_max_body_size 足够（README 部署说明里写了）。
//
// 表单：files（多选，文件名必须在白名单里）+ 可选 tag / version（二选一，
// 都缺时回退包内 VERSION 文件）。校验不过 = 400，现有 latest 不动。
func (h *Handler) ClawAdminUploadMirror(w http.ResponseWriter, r *http.Request) {
	if h.requireClawAdmin("system:write", w, r) == nil {
		return
	}
	dir := clawMirrorDir()
	if dir == "" {
		clawAdminFail(w, 503, "未配置 "+clawMirrorDirEnv+"，本部署未启用镜像功能")
		return
	}
	base := clawMirrorPublicBase()
	if base == "" {
		clawAdminFail(w, 503, "未配置 "+clawMirrorPublicBaseEnv+"（或 "+clawPublicBaseEnv+"），无法生成 latest-release.json")
		return
	}
	// 与拉取任务互斥：TryLock 抢不到说明拉取在跑（或另一个上传在跑）。
	if !clawMirror.busy.TryLock() {
		clawAdminFail(w, 409, "已有一个镜像同步任务在进行中")
		return
	}
	defer clawMirror.busy.Unlock()
	clawMirror.mu.Lock()
	clawMirror.job = clawMirrorJobState{Kind: "upload", State: "running", StartedAt: time.Now()}
	clawMirror.mu.Unlock()
	// 上传路径不走 finish()（那会 Unlock busy，而这里用的是 defer）。
	finishErr := func() (err error) {
		defer func() {
			clawMirror.mu.Lock()
			now := time.Now()
			clawMirror.job.FinishedAt = &now
			if err != nil {
				clawMirror.job.State = "failed"
				clawMirror.job.Error = err.Error()
			} else {
				clawMirror.job.State = "succeeded"
			}
			clawMirror.mu.Unlock()
		}()
		return clawMirrorUploadInto(w, r, dir, base)
	}()
	if finishErr != nil {
		clawAdminFail(w, 400, finishErr.Error())
		return
	}
	job := clawMirror.snapshot()
	clawAdminOK(w, map[string]interface{}{"tag": job.Tag})
}

// clawMirrorUploadInto 是上传的实际工作。返回 error 时镜像保持原样。
func clawMirrorUploadInto(w http.ResponseWriter, r *http.Request, dir, publicBase string) error {
	r.Body = http.MaxBytesReader(w, r.Body, clawMirrorMaxUploadBytes)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		return fmt.Errorf("上传内容过大或表单格式错误（总预算 %d MB）", clawMirrorMaxUploadBytes>>20)
	}
	defer r.MultipartForm.RemoveAll()

	allowed := clawMirrorAllowedNames()
	uploaded := map[string]bool{}
	for _, headers := range r.MultipartForm.File {
		for _, header := range headers {
			name := path.Base(strings.ReplaceAll(header.Filename, "\\", "/"))
			if !allowed[name] {
				return fmt.Errorf("不接受文件 %s：只接受 %s", name, strings.Join(clawMirrorRequiredAssets, " / "))
			}
			uploaded[name] = true
		}
	}
	// 整包校验：新旧两套名单任选其一，缺哪个就按**新名单**报缺（新名单是目标态，
	// 旧名单只是过渡期能把改名前的包传上来的兼容口）。
	if chosen, _, complete := clawMirrorPickAssetSet(uploaded); !complete {
		missing := clawMirrorMissingAssets(uploaded, chosen)
		return fmt.Errorf("缺少 %s —— 后台上传必须是一整包（6 个资产 + SHA256SUMS）", strings.Join(missing, " / "))
	}

	// 版本号：form tag → form version → 包内 VERSION 文件。三处都没有就不切换：
	// 没有版本号的镜像会让 dl/VERSION 变成 unknown，客户端比对版本失去依据。
	tag := strings.TrimSpace(r.FormValue("tag"))
	version := strings.TrimSpace(r.FormValue("version"))
	if tag == "" && version == "" {
		if fileHeaders := r.MultipartForm.File["files"]; len(fileHeaders) > 0 {
			// VERSION 文件在 files 列表里逐个找。
			for _, header := range fileHeaders {
				name := path.Base(strings.ReplaceAll(header.Filename, "\\", "/"))
				if name != "VERSION" {
					continue
				}
				f, err := header.Open()
				if err != nil {
					return fmt.Errorf("读取 VERSION 失败: %w", err)
				}
				raw, err := io.ReadAll(io.LimitReader(f, 1<<10))
				f.Close()
				if err != nil {
					return fmt.Errorf("读取 VERSION 失败: %w", err)
				}
				version = strings.TrimSpace(string(raw))
				break
			}
		}
	}
	if tag == "" && version != "" {
		tag = clawUpgradeTagFromVersion(version)
	}
	version = clawUpgradeVersionFromTag(tag)
	if !clawUpgradeVersionPattern.MatchString(version) {
		return fmt.Errorf("无法确定版本号：请在表单里填 tag（如 agentsbb-v1.4.0）或 version（如 1.4.0）")
	}
	// 统一归一成新前缀：管理员传旧 tag（clawmessenger-v1.3.33）或只传版本号都接受，
	// 落盘的 tag 一律是新前缀 —— 两个前缀客户端都认，新前缀是目标态。
	// TODO(rebrand-retire): 不再接受旧前缀输入后，这里只剩一行拼接。
	tag = clawUpgradeTagFromVersion(version)
	clawMirror.update(tag, "")

	dirMode := os.FileMode(clawMirrorDirMode)
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return fmt.Errorf("创建镜像目录失败: %w", err)
	}
	// nginx worker 要能穿过镜像根目录（符号链接指向它），与脚本一致补 755。
	_ = os.Chmod(dir, dirMode)
	stage, err := os.MkdirTemp(dir, ".incoming-")
	if err != nil {
		return fmt.Errorf("创建暂存目录失败: %w", err)
	}
	defer os.RemoveAll(stage)

	hashes := map[string]string{}
	for _, headers := range r.MultipartForm.File {
		for _, header := range headers {
			name := path.Base(strings.ReplaceAll(header.Filename, "\\", "/"))
			src, err := header.Open()
			if err != nil {
				return fmt.Errorf("读取 %s 失败: %w", name, err)
			}
			dst, err := os.OpenFile(filepath.Join(stage, name), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, clawMirrorFileMode)
			if err != nil {
				src.Close()
				return fmt.Errorf("写入暂存目录失败: %w", err)
			}
			digest := sha256.New()
			_, copyErr := io.Copy(dst, io.TeeReader(src, digest))
			src.Close()
			closeErr := dst.Close()
			if copyErr != nil {
				return fmt.Errorf("复制 %s 失败: %w", name, copyErr)
			}
			if closeErr != nil {
				return fmt.Errorf("写入 %s 失败: %w", name, closeErr)
			}
			hashes[name] = hex.EncodeToString(digest.Sum(nil))
		}
	}
	if err := clawMirrorVerifyStage(stage, hashes); err != nil {
		return err
	}
	if err := clawMirrorActivate(dir, stage, tag); err != nil {
		return err
	}
	return clawMirrorWriteManifest(dir, tag)
}

// clawMirrorVerifyStage 对照 SHA256SUMS 核对 staging 里每个必需资产的哈希。
// computed 是写入时顺手算出的哈希；不一致立即报错，绝不切换。
//
// 两套名单的处理方式：先看 staging 里齐的是哪一套（clawMirrorPickAssetSet），
// 那一套**逐个严格核对**；另一套里的文件如果也在 staging 里（整包同时带了新旧
// 两个名字，Release 上的别名资产就是这样），同样要能对上清单 —— 否则等于放过了
// 一个没校验过的文件。不在 staging 里的另一套条目直接跳过，不算缺。
func clawMirrorVerifyStage(stage string, computed map[string]string) error {
	raw, err := os.ReadFile(filepath.Join(stage, "SHA256SUMS"))
	if err != nil {
		return fmt.Errorf("读取 SHA256SUMS 失败: %w", err)
	}
	sums := parseClawSHA256Sums(string(raw))
	if len(sums) == 0 {
		return errors.New("SHA256SUMS 解析结果为空，不是 GitHub Release 签发的清单")
	}
	present := make(map[string]bool, len(computed))
	for name := range computed {
		present[name] = true
	}
	required, other, _ := clawMirrorPickAssetSet(present)
	var bad []string
	check := func(asset string, strict bool) {
		// GitHub Release 的 SHA256SUMS 不把自身列进清单，跳过它（它的存在性
		// 与完整性已由「上传里有这个文件 + 下载成功」保证）。
		if asset == "SHA256SUMS" {
			return
		}
		expected, listed := sums[asset]
		actual, hashed := computed[asset]
		switch {
		case !hashed:
			if strict {
				bad = append(bad, asset+"：文件缺失")
			}
		case !listed:
			bad = append(bad, asset+"：清单里没有它的条目")
		case expected != actual:
			bad = append(bad, fmt.Sprintf("%s：哈希不符（expected %s, actual %s）", asset, expected, actual))
		}
	}
	for _, asset := range required {
		check(asset, true)
	}
	for _, asset := range other {
		check(asset, false)
	}
	if len(bad) > 0 {
		return errors.New("校验未通过，已保留现有镜像：" + strings.Join(bad, "；"))
	}
	return nil
}

// clawMirrorActivate 原子切换：stage → latest，旧 latest → prev。
// 走到这里时 stage 已经校验通过；两步 rename 之间没有「半新半旧」的窗口。
func clawMirrorActivate(dir, stage, tag string) error {
	if err := os.WriteFile(filepath.Join(stage, "VERSION"), []byte(tag+"\n"), clawMirrorFileMode); err != nil {
		return fmt.Errorf("写 VERSION 失败: %w", err)
	}
	// nginx 只需要读：目录 755、文件 644，umask 077 的进程也不会留下 700 的目录。
	_ = os.Chmod(stage, clawMirrorDirMode)
	entries, err := os.ReadDir(stage)
	if err != nil {
		return fmt.Errorf("读取暂存目录失败: %w", err)
	}
	for _, entry := range entries {
		_ = os.Chmod(filepath.Join(stage, entry.Name()), clawMirrorFileMode)
	}
	latest := filepath.Join(dir, "latest")
	prev := filepath.Join(dir, "prev")
	if _, err := os.Lstat(latest); err == nil {
		_ = os.RemoveAll(prev)
		if err := os.Rename(latest, prev); err != nil {
			return fmt.Errorf("备份上一代失败: %w", err)
		}
	}
	if err := os.Rename(stage, latest); err != nil {
		// 尽力把 prev 还原回去，别让镜像停在「既没有 latest 也没有 prev」。
		_ = os.Rename(prev, latest)
		return fmt.Errorf("切换镜像目录失败: %w", err)
	}
	slog.Info("claw mirror: 镜像已切换", "tag", tag, "dir", latest)
	return nil
}

// clawMirrorWriteManifest 生成 latest-release.json（GitHub API 兼容格式，
// 安装脚本与 CLI 的 RELEASE_API 都按这个形状解析）。哈希以刚校验过的
// SHA256SUMS 为准，逐文件重算一遍核对 —— 两边一致才落盘。
func clawMirrorWriteManifest(dir, tag string) error {
	latest := filepath.Join(dir, "latest")
	sumsRaw, err := os.ReadFile(filepath.Join(latest, "SHA256SUMS"))
	if err != nil {
		return fmt.Errorf("读取 SHA256SUMS 失败: %w", err)
	}
	sums := parseClawSHA256Sums(string(sumsRaw))
	version := clawUpgradeVersionFromTag(tag)
	type manifestAsset struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Digest             string `json:"digest"`
	}
	// 清单要列「本镜像里真实存在」的全部资产：新旧两套名字都列（Release 上它们
	// 就是同一份字节的别名，哈希相同）。老安装脚本按旧名找、新脚本按新名找，
	// 两种都能命中。目录里没有的那一套直接跳过 —— 改名前的整包只有一套名字，
	// 不该因为缺另一套就拒绝生成清单。
	names := make([]string, 0, len(clawMirrorRequiredAssets)+len(clawMirrorLegacyAssets)+1)
	names = append(names, clawMirrorRequiredAssets...)
	names = append(names, clawMirrorLegacyAssets...)
	names = append(names, "SHA256SUMS") // 清单里也列上自己，与 GitHub Release 一致
	assets := make([]manifestAsset, 0, len(names))
	seen := map[string]bool{}
	for _, name := range names {
		if seen[name] {
			continue
		}
		seen[name] = true
		sum, ok := sums[name]
		if !ok {
			// SHA256SUMS 自身不在清单里，自己算。
			if name == "SHA256SUMS" {
				sum, err = clawMirrorHashFile(filepath.Join(latest, name))
				if err != nil {
					return fmt.Errorf("计算 SHA256SUMS 摘要失败: %w", err)
				}
			} else if _, statErr := os.Stat(filepath.Join(latest, name)); statErr != nil {
				// 文件本身不在镜像里：不是矛盾，只是这套名字没被上传过。
				continue
			} else {
				// 文件在、清单里却没有它的条目 = 清单与目录已经不一致，拒绝生成。
				return fmt.Errorf("SHA256SUMS 里没有 %s，拒绝生成版本清单", name)
			}
		}
		assets = append(assets, manifestAsset{
			Name:               name,
			BrowserDownloadURL: clawMirrorPublicBase() + "/latest/" + name,
			Digest:             "sha256:" + sum,
		})
	}
	encoded, err := json.MarshalIndent(map[string]interface{}{
		"tag_name": tag,
		// name 是给人看的显示名，用 AgentsBB（大小写规范：显示 = AgentsBB），
		// 与 Release 标题 "AgentsBB <版本>" 一致。
		"name":   "AgentsBB " + version,
		"assets": assets,
	}, "", "  ")
	if err != nil {
		return err
	}
	// 原子写：临时文件 + rename，读侧（安装脚本）永远看不到半截 JSON。
	manifestPath := filepath.Join(dir, "latest-release.json")
	tmp := manifestPath + ".tmp"
	if err := os.WriteFile(tmp, append(encoded, '\n'), clawMirrorFileMode); err != nil {
		return fmt.Errorf("写 latest-release.json 失败: %w", err)
	}
	if err := os.Rename(tmp, manifestPath); err != nil {
		return fmt.Errorf("落盘 latest-release.json 失败: %w", err)
	}
	slog.Info("claw mirror: latest-release.json 已更新", "tag", tag)
	return nil
}
