#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#ifndef RIKA_CLIENT_RUNTIME
#error "RIKA_CLIENT_RUNTIME must name the packaged client runtime"
#endif

static const char RESTORE_TERMINAL[] = "\x1b[?2026l\x1b[?25h\x1b[?1049l";

static bool equal(const char *left, const char *right) {
  return strcmp(left, right) == 0;
}

static bool starts_with(const char *value, const char *prefix) {
  return strncmp(value, prefix, strlen(prefix)) == 0;
}

static bool value_flag(const char *argument) {
  return equal(argument, "--mode") || equal(argument, "-m") || equal(argument, "--workspace") ||
         equal(argument, "--thread") || equal(argument, "--log-level");
}

static bool noninteractive_flag(const char *argument) {
  return equal(argument, "--execute") || equal(argument, "-x") || equal(argument, "--no-tui") ||
         equal(argument, "--stream-json") || equal(argument, "--stream-json-input") ||
         equal(argument, "--stream-json-thinking") || equal(argument, "--help") || equal(argument, "-h") ||
         equal(argument, "--version") || equal(argument, "-v") || equal(argument, "--completions");
}

static bool noninteractive_command(const char *argument) {
  return equal(argument, "run") || equal(argument, "auth") || equal(argument, "org") ||
         equal(argument, "project") || equal(argument, "secret") || equal(argument, "credential") ||
         equal(argument, "provider") || equal(argument, "diagnostics") || equal(argument, "update") ||
         equal(argument, "version");
}

static bool interactive_invocation(int argc, char **argv) {
  for (int index = 1; index < argc; index += 1) {
    const char *argument = argv[index];
    if (equal(argument, "--")) return true;
    if (starts_with(argument, "--completions=")) return false;
    if (noninteractive_flag(argument)) return false;
    if (value_flag(argument)) {
      index += 1;
      continue;
    }
    if (argument[0] == '-') continue;
    if (equal(argument, "thread")) return index + 1 < argc && equal(argv[index + 1], "continue");
    return !noninteractive_command(argument);
  }
  return true;
}

static bool write_all(const char *buffer, size_t length) {
  size_t written = 0;
  while (written < length) {
    const ssize_t result = write(STDOUT_FILENO, buffer + written, length - written);
    if (result > 0) {
      written += (size_t)result;
      continue;
    }
    if (result < 0 && errno == EINTR) continue;
    return false;
  }
  return true;
}

static bool paint_startup_frame(void) {
  struct winsize window = {0};
  const bool sized = ioctl(STDOUT_FILENO, TIOCGWINSZ, &window) == 0;
  const int columns = sized && window.ws_col > 0 ? window.ws_col : 80;
  const int rows = sized && window.ws_row > 0 ? window.ws_row : 24;
  const int title_column = (columns - 15) / 2 + 1 > 1 ? (columns - 15) / 2 + 1 : 1;
  const int status_column = (columns - 9) / 2 + 1 > 1 ? (columns - 9) / 2 + 1 : 1;
  const int title_row = rows / 2 > 1 ? rows / 2 : 1;
  const int status_row = title_row + 2 < rows ? title_row + 2 : rows;
  char frame[512];
  const int length = snprintf(
      frame,
      sizeof(frame),
      "\x1b[?1049h\x1b[?2026h\x1b[?25l\x1b[2J\x1b[%d;%dH\x1b[1;38;2;61;255;166mWelcome to "
      "Rika\x1b[0m\x1b[%d;%dH\x1b[2;38;5;7mStarting…\x1b[0m\x1b[?2026l",
      title_row,
      title_column,
      status_row,
      status_column);
  return length > 0 && (size_t)length < sizeof(frame) && write_all(frame, (size_t)length);
}

static bool executable_path(char *destination, size_t capacity) {
#ifdef __APPLE__
  char unresolved[PATH_MAX];
  uint32_t unresolved_capacity = sizeof(unresolved);
  if (_NSGetExecutablePath(unresolved, &unresolved_capacity) != 0) return false;
  if (realpath(unresolved, destination) != NULL) return true;
  const size_t length = strlen(unresolved);
  if (length >= capacity) return false;
  memcpy(destination, unresolved, length + 1);
  return true;
#else
  const ssize_t length = readlink("/proc/self/exe", destination, capacity - 1);
  if (length < 0 || (size_t)length >= capacity - 1) return false;
  destination[length] = '\0';
  return true;
#endif
}

static bool runtime_path(char *destination, size_t capacity) {
  char executable[PATH_MAX];
  if (!executable_path(executable, sizeof(executable))) return false;
  char *separator = strrchr(executable, '/');
  if (separator == NULL) return false;
  *separator = '\0';
  const int length = snprintf(destination, capacity, "%s/%s", executable, RIKA_CLIENT_RUNTIME);
  return length > 0 && (size_t)length < capacity;
}

int main(int argc, char **argv) {
  const bool interactive = isatty(STDIN_FILENO) && isatty(STDOUT_FILENO) && interactive_invocation(argc, argv);
  const bool painted = interactive && paint_startup_frame();
  if (painted && setenv("RIKA_STARTUP_PREVIEW", "native-v1", 1) != 0) {
    write_all(RESTORE_TERMINAL, sizeof(RESTORE_TERMINAL) - 1);
    fprintf(stderr, "rika: could not initialize startup preview: %s\n", strerror(errno));
    return 127;
  }

  char runtime[PATH_MAX];
  if (runtime_path(runtime, sizeof(runtime))) execv(runtime, argv);

  const int failure = errno;
  if (painted) write_all(RESTORE_TERMINAL, sizeof(RESTORE_TERMINAL) - 1);
  fprintf(stderr, "rika: could not start the packaged client runtime: %s\n", strerror(failure));
  return 127;
}
