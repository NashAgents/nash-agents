import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 跨平台系统剪贴板操作中枢
 * 支持 macOS (pbpaste/osascript) 与 Linux (wl-paste/xclip/xsel)
 */
export class SystemClipboard {
  /**
   * 同步读取系统剪贴板文本
   */
  static readText(): string {
    const platform = process.platform;
    try {
      if (platform === "darwin") {
        return execFileSync("pbpaste", { encoding: "utf8", timeout: 1000 });
      }
      if (platform === "linux") {
        // 优先尝试 Wayland wl-paste
        try {
          return execFileSync("wl-paste", ["--no-newline"], {
            encoding: "utf8",
            timeout: 1000,
            stdio: ["ignore", "pipe", "ignore"],
          });
        } catch {
          // 回退尝试 xclip
          try {
            return execFileSync("xclip", ["-selection", "clipboard", "-o"], {
              encoding: "utf8",
              timeout: 1000,
              stdio: ["ignore", "pipe", "ignore"],
            });
          } catch {
            // 回退尝试 xsel
            return execFileSync("xsel", ["--clipboard", "--output"], {
              encoding: "utf8",
              timeout: 1000,
              stdio: ["ignore", "pipe", "ignore"],
            });
          }
        }
      }
    } catch {
      // 剪贴板不可用或无内容时安全返回空
    }
    return "";
  }

  /**
   * 检查剪贴板中是否包含图片数据，若存在则存为临时文件并返回路径
   */
  static readImageToTempFile(targetDir?: string): string | null {
    const platform = process.platform;
    const destDir = targetDir ?? path.join(os.tmpdir(), "nash-clipboard-images");
    try {
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      const tempFilePath = path.join(destDir, `clipboard_${Date.now()}.png`);

      if (platform === "darwin") {
        // 使用 osascript 检查并转储剪贴板图片 (优先 «class PNGf»，次选 «class TIFF» 并通过 sips 转换)
        const tiffFilePath = path.join(destDir, `clipboard_${Date.now()}.tiff`);
        const script = `
          set tempPng to POSIX file "${tempFilePath}"
          set tempTiff to POSIX file "${tiffFilePath}"
          try
            set pngData to the clipboard as «class PNGf»
            set fileRef to open for access tempPng with write permission
            write pngData to fileRef
            close access fileRef
            return "png"
          on error
            try
              set tiffData to the clipboard as «class TIFF»
              set fileRef to open for access tempTiff with write permission
              write tiffData to fileRef
              close access fileRef
              return "tiff"
            on error
              return "none"
            end try
          end try
        `;
        const result = execFileSync("osascript", ["-e", script], {
          encoding: "utf8",
          timeout: 2500,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();

        if (result === "png" && fs.existsSync(tempFilePath) && fs.statSync(tempFilePath).size > 0) {
          return tempFilePath;
        }

        if (result === "tiff" && fs.existsSync(tiffFilePath) && fs.statSync(tiffFilePath).size > 0) {
          try {
            // 调用 macOS 原生 sips 工具转换为 PNG
            execFileSync("/usr/bin/sips", ["-s", "format", "png", tiffFilePath, "--out", tempFilePath], {
              timeout: 2000,
              stdio: ["ignore", "ignore", "ignore"],
            });
            try { fs.unlinkSync(tiffFilePath); } catch {}
            if (fs.existsSync(tempFilePath) && fs.statSync(tempFilePath).size > 0) {
              return tempFilePath;
            }
          } catch {
            // 若 sips 失败，直接返回 tiff 路径
            return tiffFilePath;
          }
        }
      } else if (platform === "linux") {
        // 优先 wl-paste
        try {
          execFileSync("wl-paste", ["--type", "image/png"], {
            timeout: 2000,
            stdio: ["ignore", fs.openSync(tempFilePath, "w"), "ignore"],
          });
          if (fs.existsSync(tempFilePath) && fs.statSync(tempFilePath).size > 0) {
            return tempFilePath;
          }
        } catch {
          // 回退 xclip
          try {
            execFileSync("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], {
              timeout: 2000,
              stdio: ["ignore", fs.openSync(tempFilePath, "w"), "ignore"],
            });
            if (fs.existsSync(tempFilePath) && fs.statSync(tempFilePath).size > 0) {
              return tempFilePath;
            }
          } catch {}
        }
      }
    } catch {
      // 容错安全兜底
    }
    return null;
  }

  /**
   * 同步将文本写入操作系统剪贴板
   */
  static writeText(text: string): boolean {
    const platform = process.platform;
    try {
      if (platform === "darwin") {
        execFileSync("pbcopy", { input: text, encoding: "utf8", timeout: 2000 });
        return true;
      }
      if (platform === "linux") {
        try {
          execFileSync("wl-copy", { input: text, encoding: "utf8", timeout: 2000 });
          return true;
        } catch {
          try {
            execFileSync("xclip", ["-selection", "clipboard"], { input: text, encoding: "utf8", timeout: 2000 });
            return true;
          } catch {
            try {
              execFileSync("xsel", ["--clipboard", "--input"], { input: text, encoding: "utf8", timeout: 2000 });
              return true;
            } catch {}
          }
        }
      }
    } catch {
      // 容错返回 false
    }
    return false;
  }
}
