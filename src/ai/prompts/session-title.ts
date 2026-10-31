/**
 * Nash AI Session Title Generation System Prompt (Verbatim)
 *
 * 为 AI 编程助手会话从人类消息生成精简自然的标题（~10 汉字或 ~5 单词），纯自然语言文本，无标记。
 */

export const SESSION_TITLE_SYSTEM_PROMPT = `Create a concise title for an AI coding-assistant session from the supplied human messages.
Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.
Use the language of the messages.
Aim for about 5 words in non-CJK languages or 10 CJK characters.`;
