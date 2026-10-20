// Файловые проверки output-артефактов — временный каталог, без сети.
// Запуск: npm test
import fs from "fs";
import os from "os";
import path from "path";
import {
  initialMarkdown,
  readMarkdown,
  resolveOutputPath,
  validateUniqueOutputPaths,
  writeMarkdownAtomic,
} from "./lib/artifacts.js";

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) console.log(`     ожидалось: ${JSON.stringify(expected)}\n     получено:  ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "getmes-tg-artifacts-"));
try {
  const channel = { id: "-1001", title: "Тест: канал!" };
  const file = resolveOutputPath(channel, tmp);
  check("output: безопасное имя", path.basename(file), "Тест канал.md");
  check("output: новый файл получает шапку", readMarkdown(file, channel), initialMarkdown(channel));
  writeMarkdownAtomic(file, "первая версия");
  check("output: атомарная запись опубликована", fs.readFileSync(file, "utf-8"), "первая версия");
  writeMarkdownAtomic(file, "вторая версия");
  check("output: атомарная замена опубликована", fs.readFileSync(file, "utf-8"), "вторая версия");
  check("output: tmp не остался", fs.readdirSync(tmp).some((name) => name.includes(".tmp-")), false);
  check("output: карта путей по id", validateUniqueOutputPaths([channel], tmp).get("-1001"), file);
  let collision = "";
  try {
    validateUniqueOutputPaths([
      { id: "-1001", title: "A:B" },
      { id: "-1002", title: "AB" },
    ], tmp);
  } catch (err) { collision = err.message; }
  check("output: коллизия обнаружена", collision.includes("используют один output-файл"), true);
  let empty = "";
  try { resolveOutputPath({ id: "x", title: "!!!" }, tmp); } catch (err) { empty = err.message; }
  check("output: пустое безопасное имя запрещено", empty.includes("не образует допустимое имя файла"), true);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? `\nПровалено: ${failed}` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
