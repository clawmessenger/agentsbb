//go:build windows

package agent

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// writeTestExecutable is the Windows counterpart to the //go:build unix
// implementation in exec_fixture_unix_test.go. ETXTBSY is a Linux/Unix
// fork-exec race; Windows doesn't have that pathology, so a plain
// os.WriteFile is sufficient for the script itself.
//
// Most backend fixtures (grok/claude/hermes/kimi/qoder/... ACP runtimes) are
// POSIX shell scripts with a shebang. Windows cannot exec an extensionless
// script directly: exec.LookPath looks for .com/.exe/.bat/.cmd, so the
// backend reports "executable file not found in %PATH%" even though the file
// was written. Generate a .cmd shim next to the script so LookPath resolves
// the extensionless path to it and the script runs through the available
// sh.exe (Git Bash / MSYS, which is present wherever these tests are run).
func writeTestExecutable(tb testing.TB, path string, content []byte) {
	tb.Helper()
	if err := os.WriteFile(path, content, 0o755); err != nil {
		tb.Fatalf("write test executable %s: %v", path, err)
	}
	if bytes.HasPrefix(content, []byte("#!")) {
		sh, err := exec.LookPath("sh")
		if err != nil {
			tb.Skipf("POSIX shell unavailable on Windows; skip %s: %v", path, err)
		}
		shAbs, err := filepath.Abs(sh)
		if err != nil {
			tb.Fatalf("resolve sh path %s: %v", sh, err)
		}
		scriptAbs, err := filepath.Abs(path)
		if err != nil {
			tb.Fatalf("resolve script path %s: %v", path, err)
		}
		shim := fmt.Sprintf("@echo off\r\n\"%s\" \"%s\" %%*\r\n", shAbs, scriptAbs)
		if err := os.WriteFile(path+".cmd", []byte(shim), 0o755); err != nil {
			tb.Fatalf("write test executable shim %s.cmd: %v", path, err)
		}
	}
}
