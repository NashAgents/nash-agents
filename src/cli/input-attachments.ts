import fs from "node:fs";
import path from "node:path";
import type { ChatMessageContentPart } from "../model/chat-completions-client.js";

export interface ImageMetadata {
  path: string;
  filename: string;
  width?: number;
  height?: number;
  bytes: number;
  mimeType: string;
}

export interface PastedBlock {
  id: string;
  lines: number;
  chars: number;
  content: string;
  placeholder: string;
}

const SUPPORTED_IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);

/**
 * 快速解析常用图片格式的宽度与高度 (纯二进制解析，无外部依赖)
 */
export function probeImageDimensions(
  buffer: Buffer
): { width?: number; height?: number; mimeType: string } {
  if (buffer.length < 8) {
    return { mimeType: "application/octet-stream" };
  }

  // 1. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    if (buffer.length >= 24) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height, mimeType: "image/png" };
    }
    return { mimeType: "image/png" };
  }

  // 2. GIF: GIF87a 或 GIF89a
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    if (buffer.length >= 10) {
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      return { width, height, mimeType: "image/gif" };
    }
    return { mimeType: "image/gif" };
  }

  // 3. BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    if (buffer.length >= 26) {
      const width = buffer.readInt32LE(18);
      const height = Math.abs(buffer.readInt32LE(22));
      return { width, height, mimeType: "image/bmp" };
    }
    return { mimeType: "image/bmp" };
  }

  // 4. WEBP: RIFF....WEBP
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    const type = buffer.toString("ascii", 12, 16);
    if (type === "VP8 " && buffer.length >= 30) {
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      return { width, height, mimeType: "image/webp" };
    }
    if (type === "VP8L" && buffer.length >= 25) {
      const b0 = buffer[21];
      const b1 = buffer[22];
      const b2 = buffer[23];
      const b3 = buffer[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height, mimeType: "image/webp" };
    }
    return { mimeType: "image/webp" };
  }

  // 5. JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      // SOF0 (0xC0) 到 SOF2 (0xC2)
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { width, height, mimeType: "image/jpeg" };
      }
      const length = buffer.readUInt16BE(offset + 2);
      offset += 2 + length;
    }
    return { mimeType: "image/jpeg" };
  }

  return { mimeType: "application/octet-stream" };
}

/**
 * 格式化文件字节大小为人类可读字符串 (如 120KB, 1.5MB)
 */
export function formatBytesHuman(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 附件管理器：负责输入框中长文本折叠（[Pasted text N lines]）与图片输入（[Image: ...]）
 */
export class InputAttachmentManager {
  private pastedBlocks = new Map<string, PastedBlock>();
  private imageAttachments = new Map<string, ImageMetadata>();
  private blockCounter = 0;

  /**
   * 清空所有附件状态
   */
  clear(): void {
    this.pastedBlocks.clear();
    this.imageAttachments.clear();
    this.blockCounter = 0;
  }

  /**
   * 判定一段文本是否应当折叠（行数 >= 3 或 长度 >= 120 且包含换行）
   */
  shouldCollapse(text: string): boolean {
    const lineCount = text.split(/\r?\n/).length;
    return lineCount >= 3 || (text.length >= 120 && text.includes("\n"));
  }

  /**
   * 注册一段粘贴文本为折叠块，返回在 Composer 中展示的占位标签
   * 粘贴文本摘要: [Pasted text (X lines) · Y chars]
   */
  registerPastedBlock(rawText: string): string {
    const lines = rawText.split(/\r?\n/).length;
    const chars = rawText.length;
    this.blockCounter++;
    const id = `paste_${this.blockCounter}`;

    const placeholder = `[Pasted text (${lines} lines)]`;
    this.pastedBlocks.set(placeholder, {
      id,
      lines,
      chars,
      content: rawText,
      placeholder,
    });
    return placeholder;
  }

  /**
   * 检测路径是否为存在的合法图片文件，若是则提取元数据并生成图片占位徽标
   * 图片附件摘要: [Image: filename.png (1280x720, 145KB)]
   */
  tryRegisterImage(possiblePath: string, basePath = process.cwd()): string | null {
    let cleanPath = possiblePath.trim();
    // 清除外部包裹的引号（拖拽到终端常见的格式）
    if (
      (cleanPath.startsWith('"') && cleanPath.endsWith('"')) ||
      (cleanPath.startsWith("'") && cleanPath.endsWith("'"))
    ) {
      cleanPath = cleanPath.slice(1, -1);
    }
    // 转义反斜杠处理
    cleanPath = cleanPath.replace(/\\ /g, " ");

    const ext = path.extname(cleanPath).toLowerCase();
    if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
      return null;
    }

    let resolvedPath = cleanPath;
    if (resolvedPath.startsWith("~/")) {
      resolvedPath = path.join(
        process.env.HOME || process.env.USERPROFILE || "",
        resolvedPath.slice(2)
      );
    } else if (!path.isAbsolute(resolvedPath)) {
      resolvedPath = path.resolve(basePath, resolvedPath);
    }

    try {
      if (!fs.existsSync(resolvedPath)) return null;
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) return null;

      // 限制单张图片最大 25MB
      if (stat.size > 25 * 1024 * 1024) return null;

      const buffer = fs.readFileSync(resolvedPath);
      const probed = probeImageDimensions(buffer);
      const filename = path.basename(resolvedPath);
      const sizeStr = formatBytesHuman(stat.size);
      const dimStr =
        probed.width && probed.height ? `${probed.width}x${probed.height}, ` : "";

      const placeholder = `[Image: ${filename} (${dimStr}${sizeStr})]`;
      this.imageAttachments.set(placeholder, {
        path: resolvedPath,
        filename,
        width: probed.width,
        height: probed.height,
        bytes: stat.size,
        mimeType: probed.mimeType || `image/${ext.slice(1)}`,
      });

      return placeholder;
    } catch {
      return null;
    }
  }

  /**
   * 获取所有当前已注册的占位符（用于退格键完整删除）
   */
  getAllPlaceholders(): string[] {
    return [
      ...Array.from(this.pastedBlocks.keys()),
      ...Array.from(this.imageAttachments.keys()),
    ];
  }

  /**
   * 将含有 [Pasted text ...] 占位符的用户输入文本展开为真实的完整文本内容
   */
  expandText(input: string): string {
    let result = input;
    for (const [placeholder, block] of this.pastedBlocks.entries()) {
      if (result.includes(placeholder)) {
        result = result.replaceAll(placeholder, block.content);
      }
    }
    return result;
  }

  /**
   * 收集输入中引用的所有图片附件元数据
   */
  getReferencedImages(input: string): ImageMetadata[] {
    const images: ImageMetadata[] = [];
    for (const [placeholder, meta] of this.imageAttachments.entries()) {
      if (input.includes(placeholder)) {
        images.push(meta);
      }
    }
    return images;
  }

  /**
   * 将含有图片附件的用户输入转换为适合多模态大模型的 ChatMessageContentPart[] 格式
   */
  toMessageContent(
    input: string
  ): string | ChatMessageContentPart[] {
    const expandedText = this.expandText(input);
    const images = this.getReferencedImages(input);

    if (images.length === 0) {
      return expandedText;
    }

    const parts: ChatMessageContentPart[] = [];
    let textPortion = expandedText;
    // 从文本中清除图片占位符文本，避免污染纯提示词
    for (const [placeholder] of this.imageAttachments.entries()) {
      textPortion = textPortion.replaceAll(placeholder, "").trim();
    }

    if (textPortion) {
      parts.push({ type: "text", text: textPortion });
    }

    for (const img of images) {
      try {
        const fileBuf = fs.readFileSync(img.path);
        const base64 = fileBuf.toString("base64");
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${img.mimeType};base64,${base64}`,
          },
        });
      } catch {
        // 如果文件读取失败，以文本形式提示
        parts.push({
          type: "text",
          text: `[Image attachment failed to load: ${img.path}]`,
        });
      }
    }

    return parts.length > 0 ? parts : expandedText;
  }
}
