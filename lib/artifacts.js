import fs from "fs";
import path from "path";
import { CliError } from "./cli.js";
import { atomicWriteFileSync } from "./state.js";

export function safeChannelTitle(title) {
  return String(title || "").replace(/[^a-zA-Zа-яА-Я0-9_\- ]/g, "").trim();
}

export function resolveOutputPath(channel, outputDir = "./output") {
  const safeTitle = safeChannelTitle(channel.title);
  if (!safeTitle) throw new CliError(`название канала не образует допустимое имя файла: ${channel.title}`);
  return path.join(outputDir, `${safeTitle}.md`);
}

export function validateUniqueOutputPaths(channels, outputDir = "./output") {
  const seen = new Map();
  const paths = new Map();
  for (const channel of channels || []) {
    const file = resolveOutputPath(channel, outputDir);
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (seen.has(key)) {
      throw new CliError(
        `каналы ${seen.get(key)} и ${channel.id} используют один output-файл: ${file}`
      );
    }
    seen.set(key, channel.id);
    paths.set(String(channel.id), file);
  }
  return paths;
}

export function initialMarkdown(channel) {
  return `# ${channel.title}\n\n> Канал: @${channel.id}\n\n---\n\n`;
}

export function readMarkdown(filePath, channel) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : initialMarkdown(channel);
}

export function writeMarkdownAtomic(filePath, content) {
  atomicWriteFileSync(filePath, content);
}
