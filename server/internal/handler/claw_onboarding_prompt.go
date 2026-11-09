package handler

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// onboarding-prompt is the "接入提示词" body shown in the guide appendix.
//
// It lives in the database rather than in the web bundle so editing the copy
// does not require rebuilding and re-uploading the SPA: the admin page writes
// this key, the public endpoint serves it, and the site falls back to its
// bundled copy when the key is unset (first deploy, or a bad edit rolled
// back). Stored in rongcloud_system_config as {"value": "<text>"} — the same
// envelope the generic admin config PUT produces for non-JSON values.
const (
	// onboardingPromptConfigKey holds the Chinese edition. It keeps the
	// original key name so every row written before English existed stays
	// valid, and so an admin client that knows nothing about ?lang still
	// edits the Chinese text it has always edited.
	onboardingPromptConfigKey = "agent_onboarding_prompt"
	// onboardingPromptConfigKeyEN holds the English edition. The prompt is a
	// set of instructions the visitor hands to a local AI, so serving the
	// Chinese text on an English page leaves them matching English UI against
	// Chinese instructions — that is why the language is part of the key
	// rather than a nicety.
	onboardingPromptConfigKeyEN = "agent_onboarding_prompt_en"
)

// maxOnboardingPromptBytes bounds the stored document. The current prompt is
// ~8 KB per language; 256 KB leaves room for years of copy edits while keeping
// a bad paste from filling the row.
const maxOnboardingPromptBytes = 256 << 10

type onboardingPromptView struct {
	Text      string `json:"text"`
	Lang      string `json:"lang"`
	UpdatedAt string `json:"updated_at,omitempty"`
	// Source tells the client whether the text came from the database or is
	// simply absent (the site then uses its bundled copy).
	Source string `json:"source"`
}

// onboardingPromptLang normalizes the ?lang= parameter. Anything that is not
// exactly "en" (case-insensitive) means Chinese: that is both the default for
// old clients that send no lang at all and the safe fallback for junk input.
func onboardingPromptLang(r *http.Request) string {
	if strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("lang")), "en") {
		return "en"
	}
	return "zh"
}

// normalizeOnboardingPromptLang does the same for a request body value.
func normalizeOnboardingPromptLang(lang string) string {
	if strings.EqualFold(strings.TrimSpace(lang), "en") {
		return "en"
	}
	return "zh"
}

func onboardingPromptKey(lang string) string {
	if lang == "en" {
		return onboardingPromptConfigKeyEN
	}
	return onboardingPromptConfigKey
}

// readOnboardingPrompt loads the stored prompt for one language. A missing row
// is not an error: it means "not configured yet", which the caller renders as
// an empty text plus source=default — the site then uses its own bundled copy
// in that same language, never the other language's.
func (h *Handler) readOnboardingPrompt(r *http.Request, lang string) (onboardingPromptView, error) {
	var raw []byte
	var updatedAt time.Time
	err := h.DB.QueryRow(r.Context(), `
		SELECT config, updated_at
		FROM rongcloud_system_config
		WHERE config_key = $1
		ORDER BY updated_at DESC
		LIMIT 1`, onboardingPromptKey(lang)).Scan(&raw, &updatedAt)
	if err != nil {
		if isNotFound(err) {
			return onboardingPromptView{Lang: lang, Source: "default"}, nil
		}
		return onboardingPromptView{}, err
	}
	text := decodePromptConfig(raw)
	view := onboardingPromptView{Text: text, Lang: lang, Source: "database"}
	if !updatedAt.IsZero() {
		view.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)
	}
	if text == "" {
		view.Source = "default"
	}
	return view, nil
}

// decodePromptConfig accepts both shapes the config table can hold: the
// {"value": "..."} envelope written by the admin endpoint, and a bare JSON
// string (what a hand-written row or an older tool might produce).
func decodePromptConfig(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var envelope struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(raw, &envelope); err == nil && envelope.Value != "" {
		return envelope.Value
	}
	var bare string
	if err := json.Unmarshal(raw, &bare); err == nil {
		return bare
	}
	// Not JSON at all (a jsonb column cannot normally hold this, but a null or
	// a number would land here): treat as unset.
	return ""
}

// ClawOnboardingPrompt GET /api/claw/onboarding-prompt?lang=zh|en — public.
// The product site reads this on the guide page; no auth because the text is
// shown to every visitor anyway.
func (h *Handler) ClawOnboardingPrompt(w http.ResponseWriter, r *http.Request) {
	lang := onboardingPromptLang(r)
	view, err := h.readOnboardingPrompt(r, lang)
	if err != nil {
		slog.Warn("claw: read onboarding prompt failed", "error", err, "lang", lang)
		clawJSON(w, 500, 500, "读取接入提示词失败", nil)
		return
	}
	clawJSON(w, 200, 200, "ok", view)
}

// ClawAdminOnboardingPromptGet GET /api/admin/onboarding-prompt?lang=zh|en —
// admin read. Same payload as the public endpoint so the editor shows exactly
// what the site shows, including the "not configured" state.
func (h *Handler) ClawAdminOnboardingPromptGet(w http.ResponseWriter, r *http.Request) {
	if h.requireClawAdmin("system:read", w, r) == nil {
		return
	}
	lang := onboardingPromptLang(r)
	view, err := h.readOnboardingPrompt(r, lang)
	if err != nil {
		slog.Warn("claw admin: read onboarding prompt failed", "error", err, "lang", lang)
		clawAdminFail(w, 500, "database error")
		return
	}
	clawAdminOK(w, view)
}

// ClawAdminOnboardingPromptPut PUT /api/admin/onboarding-prompt — admin write.
// Empty text clears the override for that language, which makes the site fall
// back to its bundled copy: that is the safe rollback when an edit reads badly.
func (h *Handler) ClawAdminOnboardingPromptPut(w http.ResponseWriter, r *http.Request) {
	ident := h.requireClawAdmin("system:write", w, r)
	if ident == nil {
		return
	}
	var body struct {
		Text string `json:"text"`
		// Lang is optional: an admin client that predates bilingual prompts
		// sends only text, and that must keep editing the Chinese edition.
		Lang string `json:"lang"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxOnboardingPromptBytes+1024)).Decode(&body); err != nil {
		clawAdminFail(w, 400, "JSON object with a text field is required")
		return
	}
	if len(body.Text) > maxOnboardingPromptBytes {
		clawAdminFail(w, 400, "prompt is too large")
		return
	}
	text := strings.TrimSpace(body.Text)
	lang := normalizeOnboardingPromptLang(body.Lang)
	configKey := onboardingPromptKey(lang)

	// Upsert keyed by (workspace_id, config_key): reuse the workspace that
	// already holds this key, else the oldest workspace — the same resolution
	// the generic config PUT uses, so both paths edit the same row.
	var wsID string
	if err := h.DB.QueryRow(r.Context(),
		"SELECT workspace_id::text FROM rongcloud_system_config WHERE config_key=$1 LIMIT 1",
		configKey).Scan(&wsID); err != nil {
		if err := h.DB.QueryRow(r.Context(),
			"SELECT id::text FROM workspace ORDER BY created_at LIMIT 1").Scan(&wsID); err != nil {
			clawAdminFail(w, 500, "no workspace available")
			return
		}
	}
	payload, err := json.Marshal(map[string]string{"value": text})
	if err != nil {
		clawAdminFail(w, 500, "encode prompt failed")
		return
	}
	// Same column set and conflict target as ClawAdminSystemConfigPut: both
	// paths must write the identical row, or the generic editor would show a
	// stale second copy.
	if _, err := h.DB.Exec(r.Context(), `
		INSERT INTO rongcloud_system_config (workspace_id, config_key, config)
		VALUES ($1, $2, $3)
		ON CONFLICT (workspace_id, config_key)
		DO UPDATE SET config = $3, config_version = rongcloud_system_config.config_version + 1, updated_at = now()`,
		wsID, configKey, payload); err != nil {
		slog.Warn("claw admin: write onboarding prompt failed", "error", err, "lang", lang)
		clawAdminFail(w, 500, "database error")
		return
	}
	h.clawAdminAudit(r, ident, "admin_onboarding_prompt_update", "system_config", configKey,
		map[string]interface{}{"bytes": len(text), "lang": lang})
	clawAdminOK(w, onboardingPromptView{
		Text:      text,
		Lang:      lang,
		Source:    sourceFor(text),
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

func sourceFor(text string) string {
	if text == "" {
		return "default"
	}
	return "database"
}
