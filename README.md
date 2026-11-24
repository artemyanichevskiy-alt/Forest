# Fortress Launcher

1. Залей все файлы этой папки в репозиторий на GitHub (ветка main).
2. Открой вкладку Actions -> Build EXE -> дождись зелёной галочки.
3. Внизу страницы запуска в Artifacts скачай Fortress-Launcher-Setup (внутри Fortress-Launcher-Setup.exe).
4. Запусти установщик: выбери диск и папку, нажми «Установить». После установки на рабочем столе появится ярлык «Fortress Launcher».

Локальный запуск: npm install && npm start
Сборка установщика локально (Windows): npm run dist (папка dist)

Название: package.json -> build.productName и build.nsis.shortcutName.
Иконка: icon.ico (замени своим файлом 256x256).
