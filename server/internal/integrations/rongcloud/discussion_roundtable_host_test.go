package rongcloud

import (
	"strings"
	"testing"
)

// WEB-054 复测：QA 看到主持人把「没表示反对」写成「三方接受」。除纪要任务提示词
// 之外，主持人常驻人设里也必须写清共识口径 —— 主持人的聊天发言走的正是人设，
// 只改纪要任务拦不住它。
func TestRoundtableHostInstructionsPinTheConsensusRule(t *testing.T) {
	for _, want := range []string{"明确表态", "未明确表态", "不等于同意"} {
		if !strings.Contains(roundtableHostInstructions, want) {
			t.Errorf("host instructions must mention %q: %s", want, roundtableHostInstructions)
		}
	}
	// 人设要短：它每轮都进提示词，写成一篇文章反而把发言材料挤掉。
	if n := len([]rune(roundtableHostInstructions)); n > 400 {
		t.Errorf("host instructions too long: %d runes", n)
	}
}
