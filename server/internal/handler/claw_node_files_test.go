package handler

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

// 产出文件 key 的形状校验：任何可能逃出目标目录的输入都必须在正则这一层被挡掉，
// 而不是靠后续的 filepath.Clean 兜底。
func TestClawFileKeyValidation(t *testing.T) {
	good := []string{
		"claw-files/user-u1/018f4a3b-6c1e-7a2b-9c3d-4e5f60718293.html",
		"claw-files/node-rc_node_1234/018f4a3b-6c1e-7a2b-9c3d-4e5f60718293",
		"claw-files/user-a/018F4A3B-6C1E-7A2B-9C3D-4E5F60718293.md",
	}
	for _, key := range good {
		if !validClawFileKey(key) {
			t.Fatalf("expected %q to be a valid key", key)
		}
	}
	bad := []string{
		"",
		"claw-files/user-u1/../../etc/passwd",
		"claw-files/user-u1/018f4a3b-6c1e-7a2b-9c3d-4e5f60718293/../../x",
		"/claw-files/user-u1/018f4a3b-6c1e-7a2b-9c3d-4e5f60718293",
		"claw-files/user-u1/not-a-uuid.html",
		"workspaces/abc/018f4a3b-6c1e-7a2b-9c3d-4e5f60718293.html",
		"claw-files/user-u1/018f4a3b-6c1e-7a2b-9c3d-4e5f60718293.html.exe.exe",
		"claw-files/user-u1\\018f4a3b-6c1e-7a2b-9c3d-4e5f60718293.html",
	}
	for _, key := range bad {
		if validClawFileKey(key) {
			t.Fatalf("expected %q to be rejected", key)
		}
	}
}

func newClawFileTestHandler() (*Handler, *mockStorage) {
	store := &mockStorage{}
	return &Handler{Storage: store}, store
}

// uploadThroughStore 直接打存储路径，绕开需要数据库的会话/设备鉴权：
// 本用例验证的是「存下去、key 形状对、URL 可读回」这三件事。
func uploadThroughStore(t *testing.T, h *Handler, scope, filename string, body []byte) map[string]interface{} {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := mw.WriteField("type", "file"); err != nil {
		t.Fatal(err)
	}
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	h.clawStoreUpload(w, req, scope, "file")
	if w.Code != http.StatusOK {
		t.Fatalf("upload status = %d, body = %s", w.Code, w.Body.String())
	}
	var envelope struct {
		Code int                    `json:"code"`
		Data map[string]interface{} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode upload response: %v (%s)", err, w.Body.String())
	}
	return envelope.Data
}

func TestClawUploadReturnsReadableKey(t *testing.T) {
	h, store := newClawFileTestHandler()
	html := []byte("<!doctype html><html><body>hi</body></html>")
	data := uploadThroughStore(t, h, "node-rc_node_1", "report.html", html)

	key, _ := data["key"].(string)
	if !validClawFileKey(key) {
		t.Fatalf("stored key %q must satisfy the reader's pattern", key)
	}
	if !strings.HasPrefix(key, "claw-files/node-rc_node_1/") || !strings.HasSuffix(key, ".html") {
		t.Fatalf("key layout wrong: %q", key)
	}
	if url, _ := data["url"].(string); url != "/api/claw/files/"+key {
		t.Fatalf("url = %q, want the API route for %q", url, key)
	}
	if size, _ := data["size"].(float64); int(size) != len(html) {
		t.Fatalf("size = %v, want %d", data["size"], len(html))
	}
	if typ, _ := data["type"].(string); !strings.HasPrefix(typ, "text/html") {
		t.Fatalf("type = %q, want text/html (extension override beats the sniffer)", typ)
	}
	if _, ok := store.files[key]; !ok {
		t.Fatal("file was not written to storage")
	}
}

// 读回口：坏 key 一律 404（不泄露存在性），好 key 200 且带上 iframe 预览需要的
// 安全头 —— 前端要把 PDF/HTML 内嵌进自己的页面，缺了这层会被全局 CSP 拦掉。
func TestClawServeFile(t *testing.T) {
	h, store := newClawFileTestHandler()
	store.files = map[string][]byte{}
	key := "claw-files/user-u1/018f4a3b-6c1e-7a2b-9c3d-4e5f60718293.html"
	store.files[key] = []byte("<html>x</html>")

	router := chi.NewRouter()
	router.Get("/api/claw/files/*", h.ClawServeFile)

	get := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}

	if w := get("/api/claw/files/" + key); w.Code != http.StatusOK {
		t.Fatalf("serve status = %d, body = %s", w.Code, w.Body.String())
	} else {
		if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("content-type = %q, want text/html", ct)
		}
		if csp := w.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors") {
			t.Fatalf("preview CSP missing, got %q", csp)
		}
		if w.Body.String() != "<html>x</html>" {
			t.Fatalf("body = %q", w.Body.String())
		}
	}

	if w := get("/api/claw/files/claw-files/user-u1/../../etc/passwd"); w.Code != http.StatusNotFound {
		t.Fatalf("traversal attempt must 404, got %d", w.Code)
	}
	if w := get("/api/claw/files/claw-files/user-u1/missing.html"); w.Code != http.StatusNotFound {
		t.Fatalf("missing object must 404, got %d", w.Code)
	}
}

// uploadRawThroughStore 返回原始 recorder，便于断言 4xx 拒收（不像
// uploadThroughStore 那样约定必须 200）。
func uploadRawThroughStore(t *testing.T, h *Handler, scope, filename string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := mw.WriteField("type", "file"); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	w := httptest.NewRecorder()
	h.clawStoreUpload(w, req, scope, "file")
	return w
}

func decodeClawEnvelope(t *testing.T, w *httptest.ResponseRecorder) clawEnvelope {
	t.Helper()
	var env clawEnvelope
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode response: %v (%s)", err, w.Body.String())
	}
	return env
}

// QA5-DEF-04 a：危险可执行/脚本扩展名一律 400「不支持的文件类型」，
// 大小写不敏感；正常 png 仍照旧通过。
func TestClawUploadRejectsDangerousExtensions(t *testing.T) {
	h, _ := newClawFileTestHandler()
	blocked := []string{
		"payload.exe", "PAYLOAD.EXE", "setup.msi", "run.bat", "x.CMD",
		"c.com", "s.scr", "p.pif", "d.dll", "lib.so", "lib.DYLIB",
		"macro.vbs", "s.ps1", "app.jar", "tool.app",
	}
	for _, name := range blocked {
		w := uploadRawThroughStore(t, h, "node-n1", name, []byte("MZ fake executable"))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", name, w.Code)
		}
		if env := decodeClawEnvelope(t, w); env.Code != 400 || env.Message != "不支持的文件类型" {
			t.Fatalf("%s: envelope = %+v, want 400/不支持的文件类型", name, env)
		}
	}
	// 正常附件不受影响（既有响应字段保持不变）。
	w := uploadRawThroughStore(t, h, "node-n1", "chart.png", []byte("\x89PNG\r\n\x1a\nbody"))
	if w.Code != http.StatusOK {
		t.Fatalf("png upload status = %d, body = %s", w.Code, w.Body.String())
	}
	env := decodeClawEnvelope(t, w)
	data, _ := env.Data.(map[string]interface{})
	if data == nil || data["filename"] != "chart.png" {
		t.Fatalf("png response fields changed: %+v", env.Data)
	}
}

// QA5-DEF-04 a 的纯函数：扩展名黑名单大小写不敏感，无扩展名/常规类型放行。
func TestClawFileExtAllowed(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"a.exe", false}, {"A.EXE", false}, {"a.Ps1", false}, {"a.JAR", false},
		{"a.so", false}, {"a.dylib", false}, {"a.msi", false},
		{"chart.png", true}, {"report.HTML", true}, {"notes.md", true},
		{"noextension", true}, {"archive.tar.gz", true},
	}
	for _, tc := range cases {
		if got := clawFileExtAllowed(tc.name); got != tc.want {
			t.Errorf("clawFileExtAllowed(%q) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// QA5-DEF-04 b：空文件（声明 Size=0 + 实际 0 字节）被 400「空文件不能上传」，
// 且不写进存储。25 MiB 上限本身不变（钉住常量）。
func TestClawUploadRejectsEmptyFile(t *testing.T) {
	if clawFileMaxBytes != 25<<20 {
		t.Fatalf("clawFileMaxBytes = %d, must stay 25 MiB", clawFileMaxBytes)
	}
	h, store := newClawFileTestHandler()
	w := uploadRawThroughStore(t, h, "node-n1", "empty.txt", nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty upload status = %d, want 400", w.Code)
	}
	if env := decodeClawEnvelope(t, w); env.Code != 400 || env.Message != "空文件不能上传" {
		t.Fatalf("empty upload envelope = %+v, want 400/空文件不能上传", env)
	}
	if len(store.files) != 0 {
		t.Fatalf("empty file must not be stored, got %d objects", len(store.files))
	}
}

// QA5-DEF-04 c：读回响应必须带 attachment + filename* (UTF-8) + ASCII 兜底。
func TestClawServeFileContentDisposition(t *testing.T) {
	h, store := newClawFileTestHandler()
	store.files = map[string][]byte{}
	key := "claw-files/user-u1/018f4a3b-6c1e-7a2b-9c3d-4e5f60718293.png"
	store.files[key] = []byte("png-bytes")

	router := chi.NewRouter()
	router.Get("/api/claw/files/*", h.ClawServeFile)
	get := func(target string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}

	// 不传 ?name= 时用 key 末段（uuid.ext）兜底。
	w := get("/api/claw/files/" + key)
	if w.Code != http.StatusOK {
		t.Fatalf("serve status = %d", w.Code)
	}
	cd := w.Header().Get("Content-Disposition")
	base := "018f4a3b-6c1e-7a2b-9c3d-4e5f60718293.png"
	if !strings.HasPrefix(cd, "attachment; ") ||
		!strings.Contains(cd, `filename="`+base+`"`) ||
		!strings.Contains(cd, "filename*=UTF-8''"+base) {
		t.Fatalf("Content-Disposition = %q, want attachment + ASCII fallback + filename*", cd)
	}

	// 前端显式给中文原名：filename* 用 url.QueryEscape，ASCII 兜底不含中文。
	name := "季度报告 2026.png"
	w2 := get("/api/claw/files/" + key + "?name=" + url.QueryEscape(name))
	if w2.Code != http.StatusOK {
		t.Fatalf("serve with name status = %d", w2.Code)
	}
	cd2 := w2.Header().Get("Content-Disposition")
	if !strings.HasPrefix(cd2, "attachment; ") ||
		!strings.Contains(cd2, "filename*=UTF-8''"+url.QueryEscape(name)) ||
		!strings.Contains(cd2, `filename="____ 2026.png"`) {
		t.Fatalf("Content-Disposition (Chinese) = %q, want UTF-8 filename* + ASCII fallback", cd2)
	}
}
