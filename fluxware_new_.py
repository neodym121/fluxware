# -*- coding: utf-8 -*-

import os
import re
import sys
import time
import json
import shlex
import shutil
import optparse
import threading
import collections
from pathlib import Path

if os.name == 'nt':
    import msvcrt
else:
    import tty
    import termios

try:
    import yt_dlp
except ImportError:
    print("Ошибка: Необходимо установить yt-dlp")
    print("Выполните: pip install yt-dlp")
    sys.exit(1)

# yt-dlp лениво грузит свои плагины (в т.ч. сторонние, например
# yt_dlp_plugins.extractor.getpot_bgutil_*) прямо внутри YoutubeDL.__init__,
# через проверку "if not all_plugins_loaded: load_all_plugins()" без какой-либо
# блокировки. Если несколько YoutubeDL() создаются одновременно из разных
# потоков (как в массовой скачке с несколькими воркерами), эта проверка
# гоняется в race condition, и один и тот же плагин пытается
# зарегистрироваться дважды -> AssertionError с трейсбеком прямо посреди
# загрузки (сама загрузка при этом не ломается, просто мусорит в вывод).
# Лечится тем, что грузим все плагины один раз здесь, синхронно, в главном
# потоке, до того как в дело вступят какие-либо воркеры.
try:
    from yt_dlp.plugins import load_all_plugins as _preload_yt_dlp_plugins
    _preload_yt_dlp_plugins()
except Exception:
    pass

try:
    from PIL import Image
    _PIL_AVAILABLE = True
except ImportError:
    _PIL_AVAILABLE = False

from yt_dlp.postprocessor import PostProcessor as _YDLPostProcessor
from yt_dlp.postprocessor import EmbedThumbnailPP


class SquareThumbnailPP(_YDLPostProcessor):
    """
    Обрезает скачанное превью видео (обложку) по центру в квадрат перед
    вшиванием в аудиофайл. У YouTube превьюшки почти всегда 16:9, и без
    обрезки EmbedThumbnail вшивает именно такой прямоугольник — это и
    вставляется как "обложка" плеерами. Работает по той же логике поиска
    файла, что и сам EmbedThumbnailPP (последний thumbnail с filepath),
    поэтому должна добавляться в цепочку постпроцессоров ПЕРЕД ним.
    """

    def run(self, info):
        if not _PIL_AVAILABLE:
            self.report_warning(
                'Pillow не установлен — обложка вшита как есть, без обрезки в квадрат '
                '(pip install Pillow)'
            )
            return [], info

        thumbnails = info.get('thumbnails') or []
        idx = next((-i for i, t in enumerate(thumbnails[::-1], 1) if t.get('filepath')), None)
        if idx is None:
            return [], info

        thumb_path = thumbnails[idx]['filepath']
        if not os.path.exists(thumb_path):
            return [], info

        try:
            with Image.open(thumb_path) as img:
                if img.mode not in ('RGB', 'RGBA'):
                    img = img.convert('RGB')
                w, h = img.size
                if w != h:
                    side = min(w, h)
                    left = (w - side) // 2
                    top = (h - side) // 2
                    img = img.crop((left, top, left + side, top + side))
                img.save(thumb_path)
        except Exception as e:
            self.report_warning(f'не удалось обрезать обложку в квадрат: {e}')

        return [], info


class _YDLWarningCollector:
    """
    Логгер для yt-dlp: глотает весь его вывод (как quiet + no_warnings),
    но запоминает предупреждения. Без них не понять, почему YouTube вдруг
    отдал только запасной формат 18 (360p): yt-dlp пишет об этом именно
    предупреждением ("some formats may be missing", SABR, PO Token и т.п.),
    а скачка при этом считается успешной.
    """

    def __init__(self):
        self.warnings = []

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        self.warnings.append(msg)

    def error(self, msg):
        pass


def _enable_ansi_on_windows():
    if os.name == 'nt':
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
        except Exception:
            pass


_enable_ansi_on_windows()


class C:
    """ANSI-палитра для интерфейса. Без эмодзи — только цвет и типографика."""
    RESET = '\033[0m'
    BOLD = '\033[1m'
    DIM = '\033[2m'

    FG_TEXT = '\033[38;5;253m'
    FG_MUTED = '\033[38;5;244m'
    FG_FAINT = '\033[38;5;238m'
    FG_ACCENT = '\033[38;5;79m'
    FG_ACCENT2 = '\033[38;5;80m'
    FG_OK = '\033[38;5;114m'
    FG_ERR = '\033[38;5;203m'
    FG_WARN = '\033[38;5;222m'

    @staticmethod
    def wrap(text, color):
        return f"{color}{text}{C.RESET}"


class Config:
    def __init__(self):
        self.config_file = Path.home() / '.fluxware_config.json'
        self.settings = self.load_settings()

    def load_settings(self):
        default_settings = {
            'video_format': 'mp4',
            'audio_format': 'opus',
            'custom_download_path': None,
            'custom_ytdlp_args': ''
        }
        if self.config_file.exists():
            try:
                with open(self.config_file, 'r', encoding='utf-8') as f:
                    loaded = json.load(f)
                for key, value in default_settings.items():
                    if key not in loaded:
                        loaded[key] = value
                return loaded
            except Exception:
                return default_settings
        return default_settings

    def save_settings(self):
        with open(self.config_file, 'w', encoding='utf-8') as f:
            json.dump(self.settings, f, indent=4)


class Fluxware:

    WIDTH = 62

    ASCII_ART_MAIN = r"""
    ███████████ ████
   ░░███░░░░░░█░░███
    ░███   █ ░  ░███  █████ ████ █████ █████ █████ ███ █████  ██████   ████████   ██████
    ░███████    ░███ ░░███ ░███ ░░███ ░░███ ░░███ ░███░░███  ░░░░░███ ░░███░░███ ███░░███
    ░███░░░█    ░███  ░███ ░███  ░░░█████░   ░███ ░███ ░███   ███████  ░███ ░░░ ░████████
    ░███  ░     ░███  ░███ ░███   ███░░░███  ░░███████████   ███░░███  ░███     ░███░░░
    █████       █████ ░░████████ █████ █████  ░░████░████   ░░████████ █████    ░░██████
   ░░░░░       ░░░░░   ░░░░░░░░ ░░░░░ ░░░░░    ░░░░ ░░░░     ░░░░░░░░ ░░░░░      ░░░░░░
"""

    LOADING_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']

    # JS-движки, которыми yt-dlp решает JS-задачки YouTube (подписи и т.п.).
    # Без них работает только часть клиентов, и когда они не отдают
    # форматы, остаётся лишь запасной формат 18 (360p). По умолчанию yt-dlp
    # включает только deno — node приходится включать явно. Скрипты-решалки
    # ставятся пакетом yt-dlp-ejs (pip install -U "yt-dlp[default]").
    JS_RUNTIMES = {'deno': {'path': None}, 'node': {'path': None}}

    # Ключевые слова предупреждений yt-dlp, которые объясняют пропавшие
    # форматы — их показываем пользователю, остальные не нужны.
    _FORMAT_WARNING_KEYWORDS = ('format', 'javascript', 'po token', 'sabr', 'age-restricted')

    # ─────────────────────────────────────────────────────────
    # Строка-разделитель под лого на главном экране.
    # Редактируется вручную — просто меняй текст ниже как обычную строку.
    # Строки из одних "─" красятся приглушённым цветом автоматически,
    # остальные — обычным muted-цветом.
    # ─────────────────────────────────────────────────────────
    HEADER_BAR = (
        "───────────────────────────────────────────────────────────────────────────────────────────\n"
        "                                 universal media downloader\n"
        "───────────────────────────────────────────────────────────────────────────────────────────"
    )

    def __init__(self):
        self.config = Config()
        self.current_video_info = None
        # Списки загруженных файлов за текущую сессию работы программы —
        # обнуляются только при перезапуске программы, не при переходе
        # между меню.
        self.session_video_downloads = collections.deque(maxlen=5)
        self.session_audio_downloads = collections.deque(maxlen=5)
        self.session_sc_downloads = collections.deque(maxlen=5)
        self.last_quality_warning = None

    @staticmethod
    def clear_screen():
        if os.name == 'nt':
            os.system('cls')
        else:
            # В минимальных Linux-окружениях (docker/busybox и т.п.) команды
            # 'clear' может не быть в PATH — тогда падаем на ANSI-очистку.
            if os.system('clear') != 0:
                print('\033[2J\033[H', end='')

    # ─────────────────────────── UI helpers ───────────────────────────

    def header(self):
        """Главный экран: логотип + HEADER_BAR (см. константу выше)."""
        print(C.wrap(self.ASCII_ART_MAIN, C.FG_ACCENT))
        for line in self.HEADER_BAR.split('\n'):
            is_separator = bool(line.strip()) and set(line.strip()) <= {'─'}
            color = C.FG_FAINT if is_separator else C.FG_MUTED
            print(C.wrap(line, color))
        print()

    def subheader(self, title):
        """Заголовок для вложенных экранов."""
        line = "─" * self.WIDTH
        print(C.wrap(line, C.FG_FAINT))
        print(f"  {C.wrap('FLUXWARE', C.BOLD + C.FG_ACCENT)}  {C.wrap('/', C.FG_FAINT)}  {C.wrap(title, C.FG_TEXT)}")
        print(C.wrap(line, C.FG_FAINT))
        print()

    def menu(self, items, hint=None, initial_index=0):
        """
        Интерактивное меню с управлением стрелками ↑ / ↓, подтверждение — Enter.
        items: список кортежей (key, label) или (key, label, note).
        Возвращает key выбранного пункта — совместимо со старой логикой
        (choice == '1', choice == '0' и т.д.), просто выбор теперь идёт
        стрелками, а не вводом цифры.
        initial_index: с какого пункта начинать курсор (для меню, которые
        перерисовываются в цикле — чтобы курсор не прыгал каждый раз
        обратно наверх после выбора пункта).
        """
        n = len(items)
        index = initial_index if 0 <= initial_index < n else 0
        footer = "↑ / ↓ — выбор     Enter — подтвердить"

        def render_item(i):
            label = items[i][1]
            note = items[i][2] if len(items[i]) > 2 else None
            if i == index:
                arrow = C.wrap('►', C.FG_ACCENT)
                text = C.wrap(label, C.BOLD + C.FG_ACCENT)
            else:
                arrow = ' '
                text = C.wrap(label, C.FG_TEXT)
            line = f" {arrow} {text}"
            if note:
                line += f"  {C.wrap(note, C.FG_MUTED)}"
            return line

        for i in range(n):
            print(render_item(i))
        print()
        if hint:
            print(C.wrap(f"  {hint}", C.FG_FAINT))
        print(C.wrap(f"  {footer}", C.FG_FAINT))

        total_lines = n + 2 + (1 if hint else 0)

        while True:
            key = self.read_key()

            if key == 'enter':
                return items[index][0]
            elif key == 'up':
                index = (index - 1) % n
            elif key == 'down':
                index = (index + 1) % n
            else:
                continue

            print(f"\033[{total_lines}A", end='')
            for i in range(n):
                print("\r\033[2K" + render_item(i))
            print("\r\033[2K")
            if hint:
                print("\r\033[2K" + C.wrap(f"  {hint}", C.FG_FAINT))
            print("\r\033[2K" + C.wrap(f"  {footer}", C.FG_FAINT))

    @staticmethod
    def index_of_key(items, key):
        """Находит индекс пункта меню по его key — используется, чтобы
        запомнить позицию курсора между перерисовками одного и того же меню."""
        for i, item in enumerate(items):
            if item[0] == key:
                return i
        return 0

    def ok(self, msg):
        print(f"{C.wrap('✓', C.FG_OK)} {msg}")

    def err(self, msg):
        print(f"{C.wrap('✗', C.FG_ERR)} {msg}")

    def warn(self, msg):
        print(f"{C.wrap('!', C.FG_WARN)} {msg}")

    def muted(self, msg):
        print(C.wrap(msg, C.FG_MUTED))

    def pause(self, msg="нажмите Enter для продолжения..."):
        input(f"\n{C.wrap(msg, C.FG_FAINT)}")

    def wait_skip(self, seconds=1.0):
        """
        Ждёт указанное количество секунд перед автоматическим возвратом
        в предыдущее меню, но если пользователь нажимает Enter раньше —
        пропускает оставшееся ожидание и продолжает сразу.
        """
        print(C.wrap("  возврат в меню…", C.FG_FAINT), end='', flush=True)
        start = time.time()

        if os.name == 'nt':
            while time.time() - start < seconds:
                if msvcrt.kbhit():
                    ch = msvcrt.getch()
                    if ch in (b'\r', b'\n'):
                        break
                time.sleep(0.02)
        else:
            import select
            while True:
                remaining = seconds - (time.time() - start)
                if remaining <= 0:
                    break
                r, _, _ = select.select([sys.stdin], [], [], min(0.05, remaining))
                if r:
                    # В канонiческом режиме терминала stdin становится
                    # доступным для чтения только после Enter — читаем
                    # и отбрасываем всю строку целиком.
                    sys.stdin.readline()
                    break

        print('\r' + ' ' * 60 + '\r', end='', flush=True)

    def progress_bar(self, percent, width=28):
        if isinstance(percent, (int, float)):
            pct = float(percent)
        else:
            cleaned = self.strip_ansi(percent).strip().replace('%', '')
            try:
                pct = float(cleaned)
            except (ValueError, TypeError):
                pct = 0.0
        pct = max(0.0, min(100.0, pct))
        filled = int(width * pct / 100)
        bar = "█" * filled + "░" * (width - filled)
        return f"{C.wrap(bar, C.FG_ACCENT)} {pct:5.1f}%"

    @staticmethod
    def read_key():
        """
        Считывает одно нажатие клавиши (кроссплатформенно, без Enter).
        Возвращает 'up', 'down', 'enter' или None для остальных клавиш.
        """
        if os.name == 'nt':
            ch = msvcrt.getch()
            if ch == b'\x03':
                raise KeyboardInterrupt
            if ch in (b'\x00', b'\xe0'):
                ch2 = msvcrt.getch()
                if ch2 == b'H':
                    return 'up'
                if ch2 == b'P':
                    return 'down'
                return None
            if ch in (b'\r', b'\n'):
                return 'enter'
            return None
        else:
            fd = sys.stdin.fileno()
            old_settings = termios.tcgetattr(fd)
            try:
                tty.setraw(fd)
                ch = sys.stdin.read(1)
                if ch == '\x03':
                    raise KeyboardInterrupt
                if ch == '\x1b':
                    ch2 = sys.stdin.read(1)
                    if ch2 == '[':
                        ch3 = sys.stdin.read(1)
                        if ch3 == 'A':
                            return 'up'
                        if ch3 == 'B':
                            return 'down'
                    return None
                if ch in ('\r', '\n'):
                    return 'enter'
                return None
            finally:
                termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)

    _ANSI_RE = re.compile(r'\x1b\[[0-9;]*[a-zA-Z]')

    @classmethod
    def strip_ansi(cls, text):
        """Убирает ANSI escape-последовательности из строки (их иногда
        подмешивает yt-dlp в _percent_str/_speed_str/_eta_str, из-за чего
        парсинг процента ломается и прогресс-бар всегда показывает 0%)."""
        if text is None:
            return ''
        return cls._ANSI_RE.sub('', str(text))

    @staticmethod
    def check_ffmpeg():
        """Проверяет наличие ffmpeg в PATH. Возвращает True/False."""
        return shutil.which('ffmpeg') is not None

    def warn_if_no_ffmpeg(self):
        if self.check_ffmpeg():
            return
        print()
        self.warn("ffmpeg не найден в PATH")
        self.muted("без ffmpeg не будут работать: смена контейнера, конвертация")
        self.muted("аудио, встраивание обложек и склейка видео+аудио дорожек.")
        if os.name == 'nt':
            self.muted("установка: choco install ffmpeg   (или winget install ffmpeg)")
        elif sys.platform == 'darwin':
            self.muted("установка: brew install ffmpeg")
        else:
            self.muted("установка (debian/ubuntu): sudo apt install ffmpeg")
            self.muted("установка (fedora):        sudo dnf install ffmpeg")
            self.muted("установка (arch):          sudo pacman -S ffmpeg")
        self.pause()

    @staticmethod
    def _stdin_has_pending_input():
        """
        Проверяет, есть ли в очереди ввода уже готовые, ещё не прочитанные
        данные. Нужно для ручного ввода ссылок: когда пользователь вставляет
        многострочный текст (например, скопированный лог из твиттера/дискорда),
        внутри него часто попадаются пустые строки между "блоками". Раньше
        любая пустая строка сразу завершала ввод — и по факту захватывался
        только первый кусок вставленного текста, а не весь. Если после пустой
        строки в буфере уже ждут ещё какие-то строки — значит, вставка ещё не
        закончилась, и обрывать сбор рано.
        """
        try:
            if os.name == 'nt':
                return msvcrt.kbhit()
            else:
                import select
                r, _, _ = select.select([sys.stdin], [], [], 0)
                return bool(r)
        except Exception:
            return False

    @staticmethod
    def is_url(text):
        """Определяет, является ли введённый текст ссылкой."""
        text = text.strip()
        return (
            text.startswith('http://') or
            text.startswith('https://') or
            text.startswith('www.')
        )

    def show_loading(self, text="Loading...", duration=1.0):
        start_time = time.time()
        i = 0
        while time.time() - start_time < duration:
            frame = self.LOADING_FRAMES[i % len(self.LOADING_FRAMES)]
            print(f'\r{C.wrap(frame, C.FG_ACCENT)} {C.wrap(text, C.FG_MUTED)}', end='', flush=True)
            time.sleep(0.1)
            i += 1
        print('\r' + ' ' * 60 + '\r', end='', flush=True)

    def run_with_spinner(self, fetch_fn, text="получение информации..."):
        """Запускает fetch_fn в фоне, показывая спиннер, возвращает результат."""
        result_container = {'result': None, 'finished': False}

        def worker():
            result_container['result'] = fetch_fn()
            result_container['finished'] = True

        thread = threading.Thread(target=worker)
        thread.start()

        i = 0
        while not result_container['finished']:
            frame = self.LOADING_FRAMES[i % len(self.LOADING_FRAMES)]
            print(f'\r{C.wrap(frame, C.FG_ACCENT)} {C.wrap(text, C.FG_MUTED)}', end='', flush=True)
            time.sleep(0.1)
            i += 1

        thread.join()
        print('\r' + ' ' * 60 + '\r', end='', flush=True)
        return result_container['result']

    def format_duration(self, seconds):
        if not seconds:
            return "00:00"
        mins = int(seconds // 60)
        secs = int(seconds % 60)
        return f"{mins:02d}:{secs:02d}"

    _ytdlp_defaults_cache = None

    @classmethod
    def _ytdlp_defaults(cls):
        # ydl_opts от yt_dlp.parse_options() — это ВСЕГДА полный словарь
        # всех ~170 настроек yt-dlp, а не только тех, что были явно
        # переданы. Чтобы не затереть свои же format/outtmpl/postprocessors
        # значениями по умолчанию, сравниваем с пустым вызовом и берём
        # только реально отличающиеся ключи (см. parse_custom_ytdlp_args).
        if cls._ytdlp_defaults_cache is None:
            cls._ytdlp_defaults_cache = yt_dlp.parse_options([]).ydl_opts
        return cls._ytdlp_defaults_cache

    def parse_custom_ytdlp_args(self, raw_args):
        """
        Превращает строку с параметрами yt-dlp (как в командной строке,
        например: --http-chunk-size 10M --limit-rate 5M) в словарь только
        с явно указанными ключами. При ошибке возвращает (None, текст_ошибки).
        """
        raw_args = (raw_args or '').strip()
        if not raw_args:
            return {}, None
        try:
            args = shlex.split(raw_args)
        except ValueError as e:
            return None, f"не удалось разобрать строку: {e}"
        try:
            full_opts = yt_dlp.parse_options(args).ydl_opts
        except (optparse.OptParseError, SystemExit) as e:
            return None, str(e) if str(e) else "неверный параметр"
        except Exception as e:
            return None, str(e)

        defaults = self._ytdlp_defaults()
        diff = {
            key: value for key, value in full_opts.items()
            if not key.startswith('_') and (key not in defaults or defaults[key] != value)
        }
        return diff, None

    def get_custom_ytdlp_opts(self):
        opts, error = self.parse_custom_ytdlp_args(self.config.settings.get('custom_ytdlp_args', ''))
        return opts or {}

    @staticmethod
    def _is_youtube_info(info):
        return 'youtube' in (info.get('extractor_key') or info.get('extractor') or '').lower()

    @staticmethod
    def _has_separate_video_streams(formats):
        """Есть ли среди форматов отдельные видеодорожки (без звука). У YouTube
        все нормальные качества — именно такие (DASH/HLS); если их нет,
        значит YouTube отдал только запасной формат 18 со встроенным звуком."""
        return any(
            f.get('vcodec') not in (None, 'none') and f.get('acodec') == 'none'
            for f in formats
        )

    def _relevant_ytdlp_warnings(self, warnings, limit=3):
        """Отбирает из предупреждений yt-dlp те, что про пропавшие форматы."""
        result = []
        for w in warnings:
            text = self.strip_ansi(w).strip()
            if any(k in text.lower() for k in self._FORMAT_WARNING_KEYWORDS) and text not in result:
                result.append(text)
        return result[:limit]

    def describe_quality_drop(self, info, resolution, ytdlp_warnings):
        """
        Проверяет, не скачалось ли видео хуже, чем можно было. Возвращает
        список строк для предупреждения или None, если всё в порядке.
        Раньше в таких случаях format-строка молча откатывалась на "/best",
        и вместо 1080p получался формат 18 (360p) без единого слова.
        """
        if not info or info.get('_type') in ('playlist', 'multi_video'):
            return None

        formats = info.get('formats') or []
        got = info.get('height')
        heights = [
            f['height'] for f in formats
            if f.get('height') and f.get('vcodec') not in (None, 'none')
            and (not resolution or f['height'] <= resolution)
        ]
        expected = max(heights) if heights else 0

        lines = []
        if self._is_youtube_info(info) and not self._has_separate_video_streams(formats):
            lines.append(
                f"YouTube отдал только запасной формат ({got or '?'}p со встроенным звуком) — "
                f"нормальных качеств в ответе не было"
            )
            lines.extend(f"  yt-dlp: {w}" for w in self._relevant_ytdlp_warnings(ytdlp_warnings))
            lines.append("  обычно это временно: попробуй позже или обнови yt-dlp")
            lines.append('  (pip install -U "yt-dlp[default]")')
        elif got and expected and got < expected:
            lines.append(f"скачано в {got}p, хотя доступно {expected}p")
            lines.append(
                f"  в формате {self.config.settings['video_format'].upper()} лучше не нашлось — "
                f"попробуй другой формат видео в настройках"
            )

        return lines or None

    def print_quality_warning(self, lines, indent=''):
        if not lines:
            return
        print(f"{indent}{C.wrap('!', C.FG_WARN)} {lines[0]}")
        for line in lines[1:]:
            self.muted(f"{indent}{line}")

    def get_video_info(self, url):
        collector = _YDLWarningCollector()
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'logger': collector,
            'js_runtimes': self.JS_RUNTIMES,
            **self.get_custom_ytdlp_opts(),
        }
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)

                available_heights = set()

                if 'formats' in info:
                    for fmt in info['formats']:
                        if fmt.get('height') and fmt.get('vcodec') != 'none':
                            available_heights.add(fmt['height'])

                available_heights = sorted(list(available_heights))
                max_height = max(available_heights) if available_heights else 0

                fallback_only = (
                    self._is_youtube_info(info)
                    and bool(info.get('formats'))
                    and not self._has_separate_video_streams(info['formats'])
                )

                return {
                    'fallback_only': fallback_only,
                    'ytdlp_warnings': self._relevant_ytdlp_warnings(collector.warnings),
                    'title': info.get('title', 'Без названия'),
                    'duration': info.get('duration', 0),
                    'max_resolution': f"{max_height}p" if max_height else "Unknown",
                    'available_resolutions': available_heights,
                    'url': url,
                    'uploader': info.get('uploader', info.get('artist', 'Unknown')),
                    'thumbnail': info.get('thumbnail', None),
                    'extractor_key': info.get('extractor_key', info.get('extractor', '')),
                    'uploader_id': info.get('uploader_id', ''),
                    'id': info.get('id', ''),
                    'description': info.get('description', ''),
                    'webpage_url': info.get('webpage_url', url),
                }

        except Exception as e:
            return None

    def download_video(self, url, resolution=None, audio_only=False, silent=False, show_progress=None):
        """
        silent: подавляет фразы "сохранение в:" / "загрузка завершена" /
                "ошибка при загрузке" (нужно в массовой скачке — там свои
                строки с [i/N]).
        show_progress: показывать ли живой прогресс-бар во время загрузки.
                По умолчанию совпадает с (not silent), но массовая скачка
                явно включает его отдельно, оставаясь silent.
        """
        if show_progress is None:
            show_progress = not silent

        # Строки предупреждения о заниженном качестве последней скачки —
        # их читают вызывающие меню (массовая скачка печатает их под [i/N],
        # а обычное меню не уходит назад само, пока их не прочитали).
        self.last_quality_warning = None

        if self.config.settings['custom_download_path']:
            base_path = Path(self.config.settings['custom_download_path'])
            if audio_only:
                download_path = str(base_path / 'audio')
            else:
                download_path = str(base_path / 'video')
        else:
            if audio_only:
                download_path = str(Path.home() / 'Music')
            else:
                download_path = str(Path.home() / 'Videos')

        Path(download_path).mkdir(parents=True, exist_ok=True)

        collector = _YDLWarningCollector()
        ydl_opts = {
            'outtmpl': str(Path(download_path) / '%(title)s.%(ext)s'),
            'quiet': True,
            'no_warnings': True,
            'logger': collector,
            'js_runtimes': self.JS_RUNTIMES,
            'noprogress': True,
            'progress_hooks': [self.download_progress_hook] if show_progress else [],
        }

        needs_thumbnail_embed = False

        if audio_only:
            audio_format = self.config.settings['audio_format']
            is_youtube = 'youtube.com' in url.lower() or 'youtu.be' in url.lower()

            # Обложка вшивается вручную через add_post_processor() ниже (после
            # создания YoutubeDL), чтобы вставить SquareThumbnailPP строго
            # перед EmbedThumbnail и обрезать превью в квадрат до вшивания.
            if audio_format == 'opus' and is_youtube:
                # Выкачиваем нативный Opus-поток из YouTube БЕЗ перекодирования.
                # FFmpegExtractAudio с -c:a copy просто перепакует webm → .opus
                # (смена контейнера), после чего EmbedThumbnail сработает штатно.
                ydl_opts['format'] = 'bestaudio[ext=webm][acodec=opus]/bestaudio[acodec=opus]/bestaudio'
                ydl_opts['writethumbnail'] = True
                ydl_opts['postprocessors'] = [
                    {
                        'key': 'FFmpegExtractAudio',
                        'preferredcodec': 'opus',
                        'preferredquality': '0',
                    },
                    {
                        'key': 'FFmpegMetadata',
                        'add_metadata': True,
                    },
                ]
                needs_thumbnail_embed = True
                # -c:a copy = не перекодировать, только сменить контейнер
                ydl_opts['postprocessor_args'] = {
                    'ffmpegextractaudio': ['-c:a', 'copy'],
                }
            else:
                # Для mp3 и других форматов (или не-YouTube) — перекодируем через FFmpeg
                ydl_opts['format'] = 'bestaudio/best'
                postprocessors = [
                    {
                        'key': 'FFmpegExtractAudio',
                        'preferredcodec': audio_format,
                        'preferredquality': '192',
                    }
                ]
                if is_youtube:
                    ydl_opts['writethumbnail'] = True
                    postprocessors.append({
                        'key': 'FFmpegMetadata',
                        'add_metadata': True,
                    })
                    needs_thumbnail_embed = True
                ydl_opts['postprocessors'] = postprocessors
        else:
            video_format = self.config.settings['video_format']
            if resolution:
                ydl_opts['format'] = f'bestvideo[height<={resolution}][ext={video_format}]+bestaudio/best[ext={video_format}]/best'
            else:
                ydl_opts['format'] = f'bestvideo[ext={video_format}]+bestaudio/best[ext={video_format}]/best'

            ydl_opts['merge_output_format'] = video_format

        ydl_opts.update(self.get_custom_ytdlp_opts())

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                if needs_thumbnail_embed:
                    # Порядок важен: сначала обрезаем превью в квадрат,
                    # потом штатный EmbedThumbnail вшивает уже квадратный файл.
                    ydl.add_post_processor(SquareThumbnailPP(ydl), when='post_process')
                    ydl.add_post_processor(EmbedThumbnailPP(ydl), when='post_process')
                if not silent:
                    print(f"\n{C.wrap('сохранение в:', C.FG_MUTED)} {download_path}")
                info = ydl.extract_info(url, download=True)
                if not audio_only:
                    self.last_quality_warning = self.describe_quality_drop(
                        info, resolution, collector.warnings
                    )
                if not silent:
                    # Стираем текущую строку (прогресс-бар / "обработка файла...")
                    # перед тем как печатать итоговую галочку — иначе на месте
                    # прогресса остаются видимые обрывки старого текста.
                    print('\r\033[K', end='')
                    self.ok("загрузка завершена")
                    self.print_quality_warning(self.last_quality_warning)
                return True
        except Exception as e:
            if not silent:
                print('\r\033[K', end='')
                self.err(f"ошибка при загрузке: {str(e)}")
            return False

    def download_progress_hook(self, d):
        if d['status'] == 'downloading':
            # _percent_str/_speed_str/_eta_str в yt-dlp иногда приходят с
            # подмешанными ANSI-кодами цвета — их парсинг во float падал,
            # и прогресс-бар всегда оставался на 0%. Поэтому процент считаем
            # напрямую из байтов, а строки очищаем от ANSI на всякий случай.
            downloaded = d.get('downloaded_bytes') or 0
            total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0

            if total:
                pct = downloaded / total * 100
            else:
                pct = self.strip_ansi(d.get('_percent_str', '0%'))

            speed = self.strip_ansi(d.get('_speed_str', 'N/A')).strip()
            eta = self.strip_ansi(d.get('_eta_str', 'N/A')).strip()

            bar = self.progress_bar(pct)
            speed_padded = f"{speed:<12}"
            line = f"\r  {bar}   {C.wrap(speed_padded, C.FG_MUTED)}   {C.wrap('ETA', C.FG_FAINT)} {eta}"
            # \033[K стирает всё до конца строки — надёжнее, чем дополнять
            # фиксированным числом пробелов (при переменной длине ETA/speed
            # оставались "хвосты" от предыдущей, более длинной отрисовки).
            print(f'{line}\033[K', end='', flush=True)
        elif d['status'] == 'finished':
            print(f'\r  {C.wrap("обработка файла...", C.FG_MUTED)}\033[K', end='', flush=True)

    _TCO_LINK_RE = re.compile(r'https?://t\.co/\S+', re.IGNORECASE)

    def format_download_label(self, info):
        """
        Формирует строку для истории загрузок за сессию:
        - Обычный случай:          [YouTube] Название --- Канал
        - X/Twitter без подписи:   [ X ] видео от @handle (id)
        - X/Twitter с подписью:    [ X ] Подпись --- @handle (id)

        "id" — это ID именно того поста, ссылку на который дал пользователь,
        никаких ссылок в скобках/квадратных не добавляется.
        """
        title = (info.get('title') or 'Без названия').strip()
        uploader = (info.get('uploader') or 'Unknown').strip()
        extractor = (info.get('extractor_key') or info.get('extractor') or '').lower()
        uploader_id = (info.get('uploader_id') or '').lstrip('@').strip()
        video_id = str(info.get('id') or '').strip()

        if 'twitter' in extractor:
            handle = uploader_id or uploader.lower().replace(' ', '')

            # yt-dlp обычно кладёт текст твита именно в title (description
            # часто просто дублирует его же плюс медиа-ссылку). Если после
            # вырезания t.co-ссылки из title ничего не остаётся — значит,
            # это пост без подписи (там был только медиа-линк).
            caption = self._TCO_LINK_RE.sub('', title)
            caption = re.sub(r'\s+', ' ', caption).strip()

            has_caption = bool(caption) and not self.is_url(caption)
            name_part = f"@{handle} ({video_id})"

            if has_caption:
                return f"[ X ] {caption} --- {name_part}"
            return f"[ X ] видео от {name_part}"

        platform_map = {
            'youtube': 'YouTube',
            'soundcloud': 'SoundCloud',
            'tiktok': 'TikTok',
            'instagram': 'Instagram',
            'vimeo': 'Vimeo',
            'facebook': 'Facebook',
            'twitch': 'Twitch',
            'generic': 'Media',
        }
        raw_key = info.get('extractor_key') or 'Media'
        platform_label = platform_map.get(extractor, raw_key)
        return f"[{platform_label}] {title} --- {uploader}"

    def print_recent_downloads(self, downloads_list):
        """Выводит список файлов, скачанных в этом меню за текущую сессию
        (не более 5 последних — старые уходят из очереди сами)."""
        if not downloads_list:
            return
        print()
        self.muted("загружено в этой сессии:")
        for label in downloads_list:
            print(f"  {C.wrap(label, C.FG_MUTED)}")
        print()

    def main_menu(self):
        while True:
            self.clear_screen()
            self.header()
            choice = self.menu([
                ('1', 'скачать видео'),
                ('2', 'скачать аудио'),
                ('3', 'SC mode', 'SoundCloud'),
                ('4', 'массовая скачка'),
                ('5', 'о программе'),
                ('6', 'настройки'),
                ('0', 'выход'),
            ])

            if choice == '1':
                self.download_menu()
            elif choice == '2':
                self.audio_download_menu()
            elif choice == '3':
                self.soundcloud_mode()
            elif choice == '4':
                self.batch_download_menu()
            elif choice == '5':
                self.about_menu()
            elif choice == '6':
                self.settings_menu()
            elif choice == '0':
                print()
                self.muted(" пака((((")
                sys.exit(0)

    def download_menu(self):
        while True:
            self.clear_screen()
            self.subheader("скачать видео")
            self.print_recent_downloads(self.session_video_downloads)
            url = input(C.wrap("введите ссылку на видео › ", C.FG_MUTED)).strip()

            if not url:
                return

            print()

            info_container = {'info': None, 'finished': False}

            def fetch_info():
                info_container['info'] = self.get_video_info(url)
                info_container['finished'] = True

            thread = threading.Thread(target=fetch_info)
            thread.start()

            i = 0
            while not info_container['finished']:
                frame = self.LOADING_FRAMES[i % len(self.LOADING_FRAMES)]
                print(f'\r{C.wrap(frame, C.FG_ACCENT)} {C.wrap("получение информации...", C.FG_MUTED)}', end='', flush=True)
                time.sleep(0.1)
                i += 1

            thread.join()
            print('\r' + ' ' * 60 + '\r', end='', flush=True)

            info = info_container['info']

            if not info:
                print()
                self.err("не удалось получить информацию о видео.")
                self.muted("проверьте ссылку и попробуйте снова.")
                self.pause()
                return

            self.current_video_info = info
            downloaded = self.video_options_menu()

            if downloaded:
                self.session_video_downloads.append(self.format_download_label(info))
                if self.last_quality_warning:
                    # Не уезжаем из меню сами — иначе предупреждение
                    # о заниженном качестве мелькнёт и пропадёт.
                    self.pause()
                else:
                    self.wait_skip(1.0)
                continue
            else:
                return

    def audio_download_menu(self):
        while True:
            self.clear_screen()
            self.subheader("скачать аудио")
            self.print_recent_downloads(self.session_audio_downloads)
            url = input(C.wrap("введите ссылку › ", C.FG_MUTED)).strip()

            if not url:
                return

            print()

            info = self.run_with_spinner(lambda: self.get_video_info(url))

            if not info:
                self.err("не удалось получить информацию о медиа.")
                self.muted("проверьте ссылку и попробуйте снова.")
                self.pause()
                return

            duration = self.format_duration(info['duration'])
            audio_format = self.config.settings['audio_format'].upper()

            print(f"  {C.wrap(info['title'], C.BOLD + C.FG_TEXT)}")
            print(f"  {C.wrap(duration, C.FG_MUTED)}  {C.wrap('·', C.FG_FAINT)}  исполнитель: {info['uploader']}")
            print(f"  {C.wrap('формат', C.FG_FAINT)} {audio_format}  {C.wrap('·', C.FG_FAINT)}  {C.wrap('качество', C.FG_FAINT)} максимальное")
            print()
            self.muted("начинаю загрузку аудио...")

            success = self.download_video(url, audio_only=True)

            if success:
                self.session_audio_downloads.append(self.format_download_label(info))
                self.wait_skip(1.0)
                continue
            else:
                self.pause()
                return

    def video_options_menu(self):
        while True:
            self.clear_screen()
            self.subheader("параметры загрузки")

            info = self.current_video_info
            duration = self.format_duration(info['duration'])

            print(f"  {C.wrap(info['title'], C.BOLD + C.FG_TEXT)}")
            print(f"  {C.wrap(duration, C.FG_MUTED)}  {C.wrap('·', C.FG_FAINT)}  макс. качество {C.wrap(info['max_resolution'], C.FG_ACCENT)}")
            print()

            if info.get('fallback_only'):
                self.warn("YouTube отдал только запасной формат — нормальных качеств сейчас нет")
                for w in info.get('ytdlp_warnings') or []:
                    self.muted(f"  yt-dlp: {w}")
                self.muted("  обычно это временно: попробуй позже или обнови yt-dlp")
                print()

            choice = self.menu([
                ('1', 'скачать в максимальном разрешении'),
                ('2', 'выбрать разрешение вручную'),
                ('3', 'скачать только звук'),
                ('0', 'отмена'),
            ])

            if choice == '1':
                success = self.download_video(info['url'])
                if success:
                    return True
                self.pause()
                return False
            elif choice == '2':
                resolution = self.resolution_menu()
                if resolution:
                    success = self.download_video(info['url'], resolution=resolution)
                    if success:
                        return True
                    self.pause()
                    return False
            elif choice == '3':
                success = self.download_video(info['url'], audio_only=True)
                if success:
                    return True
                self.pause()
                return False
            elif choice == '0':
                return False

    def resolution_menu(self):
        available_resolutions = self.current_video_info.get('available_resolutions', [])

        all_resolutions = [144, 240, 360, 480, 720, 1080, 1440, 2160]

        filtered_resolutions = [res for res in all_resolutions if res in available_resolutions]

        if not filtered_resolutions:
            print()
            self.err("нет доступных разрешений для выбора")
            time.sleep(2)
            return None

        resolutions_dict = {}
        for idx, res in enumerate(filtered_resolutions, 1):
            resolutions_dict[str(idx)] = res

        while True:
            self.clear_screen()
            self.subheader("выбор разрешения")

            items = [(key, f"{res}p") for key, res in resolutions_dict.items()]
            items.append(('0', 'назад'))
            choice = self.menu(items)

            if choice == '0':
                return None
            elif choice in resolutions_dict:
                return resolutions_dict[choice]

    def about_menu(self):
        self.clear_screen()
        self.subheader("о программе")
        print(C.wrap("Fluxware", C.BOLD + C.FG_ACCENT) + " — бесплатное и универсальное программное")
        print("обеспечение с открытым исходным кодом (FOSS), написанное на python")
        print("для загрузки медиафайлов из любой точки интернета (ну или почти)")
        print()
        print(C.wrap("лицензия:", C.FG_FAINT) + " MIT")
        print(C.wrap("создано при участии:", C.FG_FAINT) + " Claude Sonnet 5, Sonnet 5.5 и Opus 5.5")
        print()
        self.pause("нажмите Enter для возврата в главное меню...")

    def batch_download_menu(self):
        """Режим массовой скачки медиафайлов"""
        self.clear_screen()
        self.subheader("массовая скачка")

        source = self.menu([
            ('1', 'ввести ссылки вручную'),
            ('2', 'загрузить из текстового файла'),
            ('0', 'отмена'),
        ])

        if source == '0':
            return
        elif source == '1':
            urls = self.collect_urls_manual()
        elif source == '2':
            urls = self.collect_urls_from_file()
        else:
            return

        if not urls:
            return

        # Меню настроек массовой скачки
        self.batch_download_options(urls)

    _URL_RE = re.compile(r'(?:https?://|www\.)\S+', re.IGNORECASE)
    _URL_TRAILING_PUNCT = '.,;:!?)]}>»"\'’”'

    @staticmethod
    def extract_urls_from_text(text):
        """
        Достаёт все ссылки из произвольного текста, даже если это не
        аккуратный список, а мусорный кусок текста (например, скопированный
        лог из дискорда/твиттера, где ссылки перемешаны с именами,
        хэштегами и обычными словами) — ищет ссылки по regex прямо внутри
        текста, а не полагается на разделение по пробелам/строкам.
        Убирает дубликаты с сохранением порядка первого появления.
        """
        raw_matches = Fluxware._URL_RE.findall(text)

        cleaned = []
        for m in raw_matches:
            m = m.rstrip(Fluxware._URL_TRAILING_PUNCT)
            if m:
                cleaned.append(m)

        seen = set()
        unique_urls = []
        for u in cleaned:
            if u not in seen:
                seen.add(u)
                unique_urls.append(u)
        return unique_urls

    def collect_urls_manual(self):
        """Ручной ввод ссылок построчно."""
        self.clear_screen()
        self.subheader("массовая скачка · ручной ввод")
        print("введите ссылки на медиа материалы ниже, разделяя их запятой")
        print("или новой строкой. для завершения ввода нажмите Enter на пустой строке.")
        print(C.wrap("─" * self.WIDTH, C.FG_FAINT))
        print()

        lines = []
        self.muted("ссылки:")

        while True:
            line = input().strip()
            if not line:
                # Пустая строка сама по себе не обязательно значит "конец
                # ввода" — она может быть частью ещё доливающейся вставки.
                # Даём буферу долю секунды долиться и проверяем, не ждёт ли
                # там уже что-то ещё.
                time.sleep(0.05)
                if self._stdin_has_pending_input():
                    continue
                break
            lines.append(line)

        urls = self.extract_urls_from_text('\n'.join(lines))

        if not urls:
            self.err("не введено ни одной ссылки")
            self.pause()
            return []

        # Предпросмотр найденного — та же логика, что и при импорте из файла,
        # чтобы сразу было видно, сколько ссылок реально распозналось.
        self.clear_screen()
        self.subheader("массовая скачка · ручной ввод")
        print(f"  найдено ссылок {C.wrap(str(len(urls)), C.FG_ACCENT)}")
        print()

        preview_count = min(len(urls), 10)
        for u in urls[:preview_count]:
            print(f"    {C.wrap('•', C.FG_FAINT)} {u}")
        if len(urls) > preview_count:
            print(f"    {C.wrap(f'… и ещё {len(urls) - preview_count}', C.FG_FAINT)}")
        print()

        confirm = self.menu([
            ('1', 'да, продолжить'),
            ('0', 'отмена'),
        ])

        if confirm != '1':
            return []

        return urls

    def collect_urls_from_file(self):
        """Загрузка списка ссылок из текстового файла с подтверждением."""
        self.clear_screen()
        self.subheader("массовая скачка · импорт из файла")
        print("укажите путь до .txt файла со ссылками (по одной на строку,")
        print("либо через запятую/пробел — формат не важен).")
        print()
        path_input = input(C.wrap("путь до файла › ", C.FG_MUTED)).strip()

        if not path_input:
            return []

        path_input = path_input.strip('"').strip("'")
        file_path = Path(path_input).expanduser()

        if not file_path.exists():
            print()
            self.err(f"файл '{path_input}' не найден")
            self.pause()
            return []

        if not file_path.is_file():
            print()
            self.err(f"'{path_input}' не является файлом")
            self.pause()
            return []

        try:
            content = file_path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            try:
                content = file_path.read_text(encoding='cp1251')
            except Exception as e:
                print()
                self.err(f"не удалось прочитать файл: {e}")
                self.pause()
                return []
        except Exception as e:
            print()
            self.err(f"не удалось прочитать файл: {e}")
            self.pause()
            return []

        urls = self.extract_urls_from_text(content)

        if not urls:
            print()
            self.err("в файле не найдено ни одной ссылки")
            self.pause()
            return []

        # Подтверждение перед стартом
        self.clear_screen()
        self.subheader("массовая скачка · импорт из файла")
        print(f"  файл           {C.wrap(str(file_path), C.FG_MUTED)}")
        print(f"  найдено ссылок {C.wrap(str(len(urls)), C.FG_ACCENT)}")
        print()

        preview_count = min(len(urls), 10)
        for u in urls[:preview_count]:
            print(f"    {C.wrap('•', C.FG_FAINT)} {u}")
        if len(urls) > preview_count:
            print(f"    {C.wrap(f'… и ещё {len(urls) - preview_count}', C.FG_FAINT)}")
        print()

        confirm = self.menu([
            ('1', 'да, продолжить'),
            ('0', 'отмена'),
        ])

        if confirm != '1':
            return []

        return urls

    def batch_download_options(self, urls):
        """Настройки для массовой скачки"""
        batch_format = 'video'
        batch_quality = 'max'
        cursor_index = 0

        while True:
            self.clear_screen()
            self.subheader("массовая скачка")
            print(f"  найдено ссылок: {C.wrap(str(len(urls)), C.FG_ACCENT)}")
            print()

            items = [
                ('1', 'формат скачки', batch_format.upper()),
                ('2', 'качество', batch_quality.upper()),
                ('3', 'начать'),
                ('0', 'отмена'),
            ]
            choice = self.menu(items, initial_index=cursor_index)
            cursor_index = self.index_of_key(items, choice)

            if choice == '1':
                # Переключение формата: VIDEO ↔ AUDIO
                batch_format = 'audio' if batch_format == 'video' else 'video'
            elif choice == '2':
                # Переключение качества: MAX → 1080p → 720p → 480p → MIN → MAX
                if batch_quality == 'max':
                    batch_quality = '1080p'
                elif batch_quality == '1080p':
                    batch_quality = '720p'
                elif batch_quality == '720p':
                    batch_quality = '480p'
                elif batch_quality == '480p':
                    batch_quality = 'min'
                else:
                    batch_quality = 'max'
            elif choice == '3':
                self.execute_batch_download(urls, batch_format, batch_quality)
                break
            elif choice == '0':
                return

    def execute_batch_download(self, urls, batch_format, batch_quality):
        """Выполнение массовой скачки — строго по одной ссылке за раз,
        без параллельных потоков (были проблемы с гонками внутри yt-dlp
        при одновременной скачке нескольких ссылок)."""
        self.clear_screen()
        self.subheader("массовая скачка")
        print(f"  загружаю {C.wrap(str(len(urls)), C.FG_ACCENT)} файлов")
        print(f"  {C.wrap('формат', C.FG_FAINT)} {batch_format.upper()}  {C.wrap('·', C.FG_FAINT)}  {C.wrap('качество', C.FG_FAINT)} {batch_quality.upper()}")
        print(C.wrap("─" * self.WIDTH, C.FG_FAINT))

        successful = 0
        failed = 0

        for idx, url in enumerate(urls, 1):
            counter = C.wrap(f"[{idx}/{len(urls)}]", C.FG_MUTED)
            print(f"{counter} {url}")

            try:
                audio_only = (batch_format == 'audio')

                if audio_only:
                    result = self.download_video(url, audio_only=True, silent=True, show_progress=True)
                else:
                    if batch_quality == 'max':
                        resolution = None
                    elif batch_quality == 'min':
                        resolution = 360
                    else:
                        resolution = int(batch_quality.replace('p', ''))

                    result = self.download_video(url, resolution=resolution, silent=True, show_progress=True)
            except Exception as e:
                print('\r\033[K', end='')
                self.err(f"{counter} ошибка: {str(e)}")
                failed += 1
                continue

            # Стираем прогресс-бар/"обработка файла..." и печатаем итог
            # на его месте — той же строкой, без накопления мусора.
            print('\r\033[K', end='')
            if result:
                self.ok(f"{counter} успешно загружено")
                self.print_quality_warning(self.last_quality_warning, indent='  ')
                successful += 1
            else:
                self.err(f"{counter} ошибка загрузки")
                failed += 1

        print(C.wrap("─" * self.WIDTH, C.FG_FAINT))
        self.ok(f"успешно: {successful}")
        self.err(f"неудачно: {failed}")

        self.pause()

    def soundcloud_mode(self):
        while True:
            self.clear_screen()
            self.subheader("SC mode · SoundCloud")
            self.print_recent_downloads(self.session_sc_downloads)
            url = input(C.wrap("вставьте ссылку на трек › ", C.FG_MUTED)).strip()

            if not url:
                return

            if 'soundcloud.com' not in url:
                print()
                self.err("это не ссылка на SoundCloud")
                self.pause()
                return

            print()

            info_container = {'info': None, 'finished': False}

            def fetch_info():
                ydl_opts = {
                    'quiet': True,
                    'no_warnings': True,
                    **self.get_custom_ytdlp_opts(),
                }
                try:
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        info = ydl.extract_info(url, download=False)
                        info_container['info'] = {
                            'title': info.get('title', 'Без названия'),
                            'duration': info.get('duration', 0),
                            'uploader': info.get('uploader', 'Unknown'),
                            'url': url,
                            'extractor_key': info.get('extractor_key', info.get('extractor', 'SoundCloud')),
                            'uploader_id': info.get('uploader_id', ''),
                            'id': info.get('id', ''),
                            'description': info.get('description', ''),
                        }
                except Exception:
                    info_container['info'] = None
                info_container['finished'] = True

            thread = threading.Thread(target=fetch_info)
            thread.start()

            i = 0
            while not info_container['finished']:
                frame = self.LOADING_FRAMES[i % len(self.LOADING_FRAMES)]
                print(f'\r{C.wrap(frame, C.FG_ACCENT)} {C.wrap("получение информации о треке...", C.FG_MUTED)}', end='', flush=True)
                time.sleep(0.1)
                i += 1

            thread.join()
            print('\r' + ' ' * 60 + '\r', end='', flush=True)

            info = info_container['info']

            if not info:
                print()
                self.err("не удалось получить информацию о треке.")
                self.pause()
                return

            duration = self.format_duration(info['duration'])

            print(f"  {C.wrap(info['title'], C.BOLD + C.FG_TEXT)}")
            print(f"  исполнитель: {info['uploader']}")
            print(f"  {C.wrap('длительность', C.FG_FAINT)} {duration}")
            print()
            self.muted("начинаю загрузку...")

            if self.config.settings['custom_download_path']:
                base_path = Path(self.config.settings['custom_download_path'])
                download_path = str(base_path / 'audio')
            else:
                download_path = str(Path.home() / 'Music')

            Path(download_path).mkdir(parents=True, exist_ok=True)

            audio_format = self.config.settings['audio_format']
            ydl_opts = {
                'outtmpl': str(Path(download_path) / '%(title)s.%(ext)s'),
                'format': 'bestaudio/best',
                'writethumbnail': True,
                'quiet': True,
                'no_warnings': True,
                'noprogress': True,
                'postprocessors': [
                    {
                        'key': 'FFmpegExtractAudio',
                        'preferredcodec': audio_format,
                        'preferredquality': '192',
                    },
                    {
                        'key': 'FFmpegMetadata',
                        'add_metadata': True,
                    },
                    {
                        'key': 'EmbedThumbnail',
                    },
                ],
                'progress_hooks': [self.download_progress_hook],
            }
            ydl_opts.update(self.get_custom_ytdlp_opts())

            success = False
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    print(f"\n{C.wrap('сохранение в:', C.FG_MUTED)} {download_path}")
                    ydl.download([url])
                    print('\r\033[K', end='')
                    self.ok("трек успешно загружен")
                    success = True
            except Exception as e:
                print('\r\033[K', end='')
                self.err(f"ошибка при загрузке: {str(e)}")

            if success:
                self.session_sc_downloads.append(self.format_download_label(info))
                self.wait_skip(1.0)
                continue
            else:
                self.pause()
                return

    def settings_menu(self):
        cursor_index = 0
        while True:
            self.clear_screen()
            self.subheader("настройки")

            video_format = self.config.settings['video_format'].upper()
            audio_format = self.config.settings['audio_format'].upper()

            if self.config.settings['custom_download_path']:
                path_display = self.config.settings['custom_download_path']
            else:
                path_display = "по умолчанию"

            custom_args = self.config.settings.get('custom_ytdlp_args', '')
            if custom_args:
                args_display = custom_args if len(custom_args) <= 28 else custom_args[:25] + '...'
            else:
                args_display = "не заданы"

            items = [
                ('1', 'формат видео', video_format),
                ('2', 'формат аудио', audio_format),
                ('3', 'папка загрузки', path_display),
                ('4', 'свои параметры yt-dlp', args_display),
                ('0', 'назад'),
            ]
            choice = self.menu(items, initial_index=cursor_index)
            cursor_index = self.index_of_key(items, choice)

            if choice == '1':
                if self.config.settings['video_format'] == 'mp4':
                    self.config.settings['video_format'] = 'webm'
                else:
                    self.config.settings['video_format'] = 'mp4'
                self.config.save_settings()
            elif choice == '2':
                if self.config.settings['audio_format'] == 'opus':
                    self.config.settings['audio_format'] = 'mp3'
                else:
                    self.config.settings['audio_format'] = 'opus'
                self.config.save_settings()
            elif choice == '3':
                self.set_custom_download_path()
            elif choice == '4':
                self.set_custom_ytdlp_args()
            elif choice == '0':
                break

    def set_custom_ytdlp_args(self):
        self.clear_screen()
        self.subheader("свои параметры yt-dlp")
        current = self.config.settings.get('custom_ytdlp_args', '')
        if current:
            print(f"  {C.wrap('сейчас:', C.FG_FAINT)} {current}")
            print()

        print("вводятся как в командной строке, например:")
        print("  --http-chunk-size 10M --limit-rate 5M")
        print("применяются ко всем скачкам и перебивают собственные")
        print("настройки fluxware при конфликте (формат, папка и т.д.)")
        print("пусто — очистить")
        print()

        raw = input(C.wrap("параметры › ", C.FG_MUTED)).strip()

        if not raw:
            self.config.settings['custom_ytdlp_args'] = ''
            self.config.save_settings()
            print()
            self.ok("параметры очищены")
            self.pause()
            return

        opts, error = self.parse_custom_ytdlp_args(raw)
        if error:
            print()
            self.err(f"ошибка в параметрах: {error}")
            self.pause()
            return

        self.config.settings['custom_ytdlp_args'] = raw
        self.config.save_settings()
        print()
        self.ok(f"сохранено ({len(opts)} параметр(ов) распознано)")
        self.pause()

    def set_custom_download_path(self):
        if self.config.settings['custom_download_path']:
            self.clear_screen()
            self.subheader("папка загрузки")
            print(f"  {C.wrap('текущий путь', C.FG_FAINT)} {self.config.settings['custom_download_path']}")
            print()

            choice = self.menu([
                ('1', 'изменить путь'),
                ('2', 'вернуть папки по умолчанию'),
                ('0', 'назад'),
            ])

            if choice == '1':
                self.config.settings['custom_download_path'] = None
                self.config.save_settings()
                self.set_custom_download_path()
                return
            elif choice == '2':
                self.config.settings['custom_download_path'] = None
                self.config.save_settings()
                print()
                self.ok("возвращены папки по умолчанию")
                self.pause()
                return
            elif choice == '0':
                return

        self.clear_screen()
        self.subheader("папка загрузки")

        path_input = input(C.wrap("введите путь до папки › ", C.FG_MUTED)).strip()

        if not path_input:
            return

        path_input = path_input.strip('"').strip("'")

        target_path = Path(path_input)

        if not target_path.exists():
            print()
            self.err(f"путь '{path_input}' не существует")
            self.pause()
            return

        if not target_path.is_dir():
            print()
            self.err(f"'{path_input}' не является папкой")
            self.pause()
            return

        self.clear_screen()
        self.subheader("папка загрузки")
        print(f'в директории "{target_path}" будет происходить скачка всех медиафайлов')
        print('через fluxware. программа создаст в ней две подпапки —')
        print('"audio" и "video". продолжить?')
        print()

        confirm = self.menu([
            ('1', 'да, дать доступ'),
            ('2', 'нет, отмена'),
        ])

        if confirm == '1':
            try:
                audio_path = target_path / 'audio'
                video_path = target_path / 'video'

                audio_path.mkdir(exist_ok=True)
                video_path.mkdir(exist_ok=True)

                self.config.settings['custom_download_path'] = str(target_path)
                self.config.save_settings()
                print()
                self.ok("путь успешно установлен")
                print(f"  {C.wrap('audio', C.FG_FAINT)} {audio_path}")
                print(f"  {C.wrap('video', C.FG_FAINT)} {video_path}")
            except Exception as e:
                print()
                self.err(f"ошибка при создании папок: {str(e)}")

            self.pause()
        elif confirm == '2':
            print()
            self.err("отменено")
            time.sleep(1)

    def run(self):
        try:
            if not self.check_ffmpeg():
                self.clear_screen()
                self.header()
                self.warn_if_no_ffmpeg()
            self.main_menu()
        except KeyboardInterrupt:
            print()
            self.muted("\nпрограмма прервана пользователем о_0.")
            sys.exit(0)


if __name__ == "__main__":
    app = Fluxware()
    app.run()
