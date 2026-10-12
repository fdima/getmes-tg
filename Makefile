# Сборка бинарей всего приложения через Bun runtime.
#   make            — сборка под все x64-платформы в dist/ + zip каждого бинаря
#   make windows    — только Windows x64 (.exe + .zip)
#   make linux      — только Linux x64 (+ .zip)
#   make macos      — только macOS Intel (+ .zip)
#   make sha256     — контрольные суммы артефактов в dist/SHA256SUMS
#                     (создаётся автоматически после любой сборки)
#   make test       — npm test
#   make clean      — удалить dist/  ⚠️ если бинарь запускается из dist
#                     (там же config.yaml, session.txt, output/, state/,
#                     logs/), clean сотрёт и их — чистите осознанно
#
# Сборка под arm64 ВРЕМЕННО ОТКЛЮЧЕНА (закомментирована): целы
# windows-arm64 / linux-arm64 / darwin-arm64 и алиасы windows-arm /
# macos-arm. Чтобы вернуть — раскомментируйте их, включите arm64-цели
# в TARGETS и строки .PHONY.
#
# На Windows без make те же команды вызываются напрямую, например:
#   bun build ./export.js --compile --target=bun-windows-x64 --outfile dist/getmes-tg-windows-x64.exe
# Упаковка в zip на Windows (PowerShell, из каталога с бинарём):
#   Compress-Archive -Path getmes-tg-windows-x64.exe -DestinationPath getmes-tg-windows-x64.exe.zip -Force
# Контрольные суммы на Windows (PowerShell, из каталога с артефактами):
#   Get-FileHash getmes-tg-* -Algorithm SHA256 | ForEach-Object { "{0}  {1}" -f $_.Hash.ToLower(), (Split-Path $_.Path -Leaf) } > SHA256SUMS

ENTRY  := export.js
OUTDIR := dist
NAME   := getmes-tg

# Доп. флаги bun build: make BUN_FLAGS=--minify
BUN_FLAGS ?=

# Контрольные суммы: sha256sum (GNU/Linux) либо shasum -a 256 (macOS)
SHA256 := $(shell command -v sha256sum >/dev/null 2>&1 && echo sha256sum || echo "shasum -a 256")
# Что хешировать: по умолчанию все артефакты (бинари и zip). Только zip:
#   make sha256 SHA256_FILES='$(NAME)-*.zip'
SHA256_FILES ?= $(NAME)-*

# Цели arm64 (windows-arm64, linux-arm64, darwin-arm64) закомментированы —
# см. комментарий в шапке
TARGETS := \
	windows-x64 \
	linux-x64 \
	darwin-x64

# Имя файла бинаря: .exe для Windows, без расширения для остальных;
# zip-архив создаётся рядом с бинарём: <имя>.zip (см. цели ниже)
outfile = $(OUTDIR)/$(NAME)-$(1)$(if $(findstring windows,$(1)),.exe,)

.PHONY: all windows linux macos sha256 test clean

all: $(TARGETS)
	@$(MAKE) --no-print-directory sha256

# После каждой сборки: упаковать бинарь в zip рядом с ним, затем
# пересчитать контрольные суммы (SHA256SUMS покрывает и бинари, и zip)
windows-x64:
	bun build ./$(ENTRY) --compile --target=bun-windows-x64 $(BUN_FLAGS) --outfile $(call outfile,windows-x64)
	@cd $(OUTDIR) && zip -9 -q $(notdir $(call outfile,windows-x64)).zip $(notdir $(call outfile,windows-x64))
	@$(MAKE) --no-print-directory sha256

# Сборка arm64 отключена:
# windows-arm64:
#     bun build ./$(ENTRY) --compile --target=bun-windows-arm64 $(BUN_FLAGS) --outfile $(call outfile,windows-arm64)

linux-x64:
	bun build ./$(ENTRY) --compile --target=bun-linux-x64 $(BUN_FLAGS) --outfile $(call outfile,linux-x64)
	@cd $(OUTDIR) && zip -9 -q $(notdir $(call outfile,linux-x64)).zip $(notdir $(call outfile,linux-x64))
	@$(MAKE) --no-print-directory sha256

# Сборка arm64 отключена:
# linux-arm64:
#     bun build ./$(ENTRY) --compile --target=bun-linux-arm64 $(BUN_FLAGS) --outfile $(call outfile,linux-arm64)

darwin-x64:
	bun build ./$(ENTRY) --compile --target=bun-darwin-x64 $(BUN_FLAGS) --outfile $(call outfile,darwin-x64)
	@cd $(OUTDIR) && zip -9 -q $(notdir $(call outfile,darwin-x64)).zip $(notdir $(call outfile,darwin-x64))
	@$(MAKE) --no-print-directory sha256

# Сборка arm64 отключена:
# darwin-arm64:
#     bun build ./$(ENTRY) --compile --target=bun-darwin-arm64 $(BUN_FLAGS) --outfile $(call outfile,darwin-arm64)

# Короткие алиасы
windows: windows-x64
# windows-arm: windows-arm64    # отключено (arm64)
linux: linux-x64
macos: darwin-x64
# macos-arm: darwin-arm64       # отключено (arm64)

# Контрольные суммы артефактов → $(OUTDIR)/SHA256SUMS (запускается и
# автоматически после любой сборки). Перегенерация всегда целиком по
# содержимому dist/; имена — без пути (проверка: cd dist && sha256sum -c
# SHA256SUMS); прочее содержимое dist (config, сессия, каталоги) не
# хешируется и не затрагивается.
sha256:
	@mkdir -p $(OUTDIR)
	@cd $(OUTDIR) && files=$$(ls $(SHA256_FILES) 2>/dev/null); \
	if [ -n "$$files" ]; then \
		$(SHA256) $$files > SHA256SUMS.tmp && mv -f SHA256SUMS.tmp SHA256SUMS; \
		echo "sha256: $(OUTDIR)/SHA256SUMS — $$(echo $$files | wc -w) файл(ов)"; \
	else \
		rm -f SHA256SUMS.tmp SHA256SUMS; \
		echo "sha256: файлов $(SHA256_FILES) в $(OUTDIR)/ нет — SHA256SUMS не создан"; \
	fi

test:
	npm test

clean:
	rm -rf $(OUTDIR)
