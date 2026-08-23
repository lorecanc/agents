import { execSync } from "node:child_process"

const FALLBACK_MODELS = [
  "opencode/big-pickle",
  "opencode/deepseek-v4-flash-free",
  "opencode/hy3-free",
  "opencode/mimo-v2.5-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/north-mini-code-free",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-pro",
  "opencode-go/glm-5.1",
  "opencode-go/glm-5.2",
  "opencode-go/kimi-k2.6",
  "opencode-go/kimi-k2.7-code",
  "opencode-go/mimo-v2.5",
  "opencode-go/mimo-v2.5-pro",
  "opencode-go/minimax-m2.7",
  "opencode-go/minimax-m3",
  "opencode-go/qwen3.6-plus",
  "opencode-go/qwen3.7-max",
  "opencode-go/qwen3.7-plus",
  "github-copilot/claude-haiku-4.5",
  "github-copilot/claude-opus-4.5",
  "github-copilot/claude-opus-4.6",
  "github-copilot/claude-opus-4.6-fast",
  "github-copilot/claude-opus-4.7",
  "github-copilot/claude-opus-4.7-fast",
  "github-copilot/claude-opus-4.8",
  "github-copilot/claude-opus-4.8-fast",
  "github-copilot/claude-sonnet-4.5",
  "github-copilot/claude-sonnet-4.6",
  "github-copilot/claude-sonnet-5",
  "github-copilot/gemini-2.5-pro",
  "github-copilot/gemini-3-flash-preview",
  "github-copilot/gemini-3.1-pro-preview",
  "github-copilot/gemini-3.5-flash",
  "github-copilot/gpt-5-mini",
  "github-copilot/gpt-5.3-codex",
  "github-copilot/gpt-5.4",
  "github-copilot/gpt-5.4-mini",
  "github-copilot/mai-code-1-flash-picker",
  "minimax-coding-plan/MiniMax-M2",
  "minimax-coding-plan/MiniMax-M2.1",
  "minimax-coding-plan/MiniMax-M2.5",
  "minimax-coding-plan/MiniMax-M2.5-highspeed",
  "minimax-coding-plan/MiniMax-M2.7",
  "minimax-coding-plan/MiniMax-M2.7-highspeed",
  "minimax-coding-plan/MiniMax-M3"
]

/**
 * Fetch list of models by executing 'opencode models' in the terminal.
 * Falls back to a predefined list if the command fails.
 */
export function fetchModels(): string[] {
  try {
    // execSync already uses a shell (cmd.exe on Windows), which resolves .cmd via PATHEXT.
    // Do not add shell: true: it is not needed for Windows command resolution.
    const output = execSync("opencode models", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
    const models = output
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0)
    
    if (models.length > 0) {
      return models
    }
  } catch (e) {
    // Silent fail, return fallback list
  }
  return FALLBACK_MODELS
}
