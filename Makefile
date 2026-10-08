# Сборка бинарей всего приложения через Bun runtime.
#   make            — сборка под все x64-платформы в dist/
#   make windows    — только Windows x64 (.exe)
#   make linux      — только Linux x64
#   make macos      — только macOS Intel
#   make test       — npm test
#   make clean      — удалить dist/
#
# Сборка под arm64 ВРЕМЕННО ОТКЛЮЧЕНА (закомментирована): целы
# windows-arm64 / linux-arm64 / darwin-arm64 и алиасы windows-arm /
# macos-arm. Чтобы вернуть — раскомментируйте их, включите arm64-цели
# в TARGETS и строки .PHONY.
#
# На Windows без make те же команды вызываются напрямую, например:
#   bun build ./export.js --compile --target=bun-windows-x64 --outfile dist/getmes-tg-windows-x64.exe

ENTRY  := export.js
OUTDIR := dist
NAME   := getmes-tg

# Доп. флаги bun build: make BUN_FLAGS=--minify
BUN_FLAGS ?=

# Цели arm64 (windows-arm64, linux-arm64, darwin-arm64) закомментированы —
# см. комментарий в шапке
TARGETS := \
	windows-x64 \
	linux-x64 \
	darwin-x64

# Имя файла бинаря: .exe для Windows, без расширения для остальных
outfile = $(OUTDIR)/$(NAME)-$(1)$(if $(findstring windows,$(1)),.exe,)

.PHONY: all windows linux macos test clean

all: $(TARGETS)

windows-x64:
	bun build ./$(ENTRY) --compile --target=bun-windows-x64 $(BUN_FLAGS) --outfile $(call outfile,windows-x64)

# Сборка arm64 отключена:
# windows-arm64:
#     bun build ./$(ENTRY) --compile --target=bun-windows-arm64 $(BUN_FLAGS) --outfile $(call outfile,windows-arm64)

linux-x64:
	bun build ./$(ENTRY) --compile --target=bun-linux-x64 $(BUN_FLAGS) --outfile $(call outfile,linux-x64)

# Сборка arm64 отключена:
# linux-arm64:
#     bun build ./$(ENTRY) --compile --target=bun-linux-arm64 $(BUN_FLAGS) --outfile $(call outfile,linux-arm64)

darwin-x64:
	bun build ./$(ENTRY) --compile --target=bun-darwin-x64 $(BUN_FLAGS) --outfile $(call outfile,darwin-x64)

# Сборка arm64 отключена:
# darwin-arm64:
#     bun build ./$(ENTRY) --compile --target=bun-darwin-arm64 $(BUN_FLAGS) --outfile $(call outfile,darwin-arm64)

# Короткие алиасы
windows: windows-x64
# windows-arm: windows-arm64    # отключено (arm64)
linux: linux-x64
macos: darwin-x64
# macos-arm: darwin-arm64       # отключено (arm64)

test:
	npm test

clean:
	rm -rf $(OUTDIR)
