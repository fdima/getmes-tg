// Юнит-проверки разметки (applyEntities / entityTags) из lib/markdown.js.
// Запуск: npm test
import { applyEntities, formatMessageToMarkdown } from "./lib/markdown.js";

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) console.log(`     ожидалось: ${JSON.stringify(expected)}\n     получено:  ${JSON.stringify(actual)}`);
}

// 1. Ссылка внутри жирного (то, что ломало вывод в Интерфаксе)
check(
  "bold + texturl внутри",
  applyEntities("aaa bbb ccc", [
    { className: "MessageEntityBold", offset: 0, length: 11 },
    { className: "MessageEntityTextUrl", offset: 4, length: 3, url: "https://x" },
  ]),
  "**aaa [bbb](https://x) ccc**"
);

// 2. Просто жирный
check(
  "bold",
  applyEntities("привет мир", [{ className: "MessageEntityBold", offset: 0, length: 6 }]),
  "**привет** мир"
);

// 3. Соседние entity (закрытие перед открытием на одной позиции)
check(
  "adjacent",
  applyEntities("абвгд", [
    { className: "MessageEntityBold", offset: 0, length: 2 },
    { className: "MessageEntityItalic", offset: 2, length: 2 },
  ]),
  "**аб***вг*д"
);

// 4. Курсив внутри жирного (оба с offset 0)
check(
  "nested same offset",
  applyEntities("весьтекст", [
    { className: "MessageEntityBold", offset: 0, length: 9 },
    { className: "MessageEntityItalic", offset: 0, length: 4 },
  ]),
  "***весь*текст**"
);

// 5. Bare URL
check(
  "url",
  applyEntities("см. https://t.me/x и дальше", [
    { className: "MessageEntityUrl", offset: 4, length: 14 },
  ]),
  "см. <https://t.me/x> и дальше"
);

// 6. Код
check(
  "code",
  applyEntities("вызов foo() тут", [{ className: "MessageEntityCode", offset: 6, length: 5 }]),
  "вызов `foo()` тут"
);

// 7. Цитата в две строки
check(
  "blockquote multiline",
  applyEntities("строка1\nстрока2", [
    { className: "MessageEntityBlockquote", offset: 0, length: 15 },
  ]),
  "> строка1\n> строка2"
);

// 8. Без entity текст не меняется
check("без entity", applyEntities("обычный текст", []), "обычный текст");

// 9. Зачёркивание с переносом строки
check(
  "strike с переносом",
  applyEntities("до\nпосле хвост", [
    { className: "MessageEntityStrike", offset: 0, length: 8 },
  ]),
  "~~до\nпосле~~ хвост"
);

// 10. MentionName
check(
  "mentionName",
  applyEntities("привет, Иван", [
    { className: "MessageEntityMentionName", offset: 8, length: 4, userId: 42 },
  ]),
  "привет, [Иван](tg://user?id=42)"
);

// 11. Эмодзи до entity (UTF-16 смещения)
check(
  "эмодзи в тексте",
  applyEntities("🔥 горячо", [{ className: "MessageEntityBold", offset: 3, length: 6 }]),
  "🔥 **горячо**"
);

// 12. Pre (блок кода)
check(
  "pre",
  applyEntities("до x = 1 после", [
    { className: "MessageEntityPre", offset: 3, length: 5 },
  ]),
  "до ```\nx = 1\n``` после"
);

// 13. Структура как в реальном сообщении #79401 (ссылка внутри жирного,
//     плюс соседний жирный блок сразу за ней)
{
  const t = "A".repeat(77) + "B".repeat(10) + "C".repeat(90);
  check(
    "структура #79401 (bold + link + bold)",
    applyEntities(t, [
      { className: "MessageEntityBold", offset: 0, length: 77 },
      { className: "MessageEntityTextUrl", offset: 77, length: 10, url: "https://x" },
      { className: "MessageEntityBold", offset: 77, length: 10 },
      { className: "MessageEntityBold", offset: 87, length: 90 },
    ]),
    `**${"A".repeat(77)}[${"B".repeat(10)}](https://x)${"C".repeat(90)}**`
  );
}

// 14. Два соседних жирных блока сливаются в один непрерывный
check(
  "adjacent bold merge",
  applyEntities("абвгд", [
    { className: "MessageEntityBold", offset: 0, length: 2 },
    { className: "MessageEntityBold", offset: 2, length: 3 },
  ]),
  "**абвгд**"
);

// 15. formatMessageToMarkdown: ссылка на сообщение отдельной строкой
{
  const out = formatMessageToMarkdown(
    { id: 42, date: 1759363200, rawText: "привет", entities: [] },
    "Интерфакс",
    "-1001149896996"
  );
  check(
    "ссылка на сообщение отдельной строкой",
    out.includes("**Ссылка:** https://t.me/c/1149896996/42"),
    true
  );
  check(
    "ссылка стоит после даты и до текста",
    out.indexOf("**Дата:**") < out.indexOf("**Ссылка:**") &&
      out.indexOf("**Ссылка:**") < out.indexOf("привет"),
    true
  );
  const noId = formatMessageToMarkdown(
    { id: 42, date: 1759363200, rawText: "привет", entities: [] },
    "Интерфакс",
    undefined
  );
  check("без channelId строки ссылки нет", noId.includes("**Ссылка:**"), false);
}

console.log(failed ? `\nПровалено: ${failed}` : "\nВсе проверки пройдены");
process.exit(failed ? 1 : 0);
