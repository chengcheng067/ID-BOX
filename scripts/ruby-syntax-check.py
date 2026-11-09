"""用 SketchUp 2024 自带的 x64-ucrt-ruby320.dll（CRuby 3.2.2）做真 Ruby 语法检查。

本机没有 ruby.exe（`which ruby` 为空），但 SketchUp 2024 自带完整 CRuby 运行时。
走嵌入式 API：
    ruby_sysinit -> ruby_init_stack(真实栈顶) -> ruby_init -> ruby_init_loadpath
    -> rb_eval_string_protect(RubyVM::InstructionSequence.compile(File.read(path)))

两个踩过的坑（别改回去）：
1. ruby_init_stack 必须喂**真实线程栈地址**。拿 Python 堆变量地址会让 Ruby 算出
   错误的栈范围，直接 `[BUG] Segmentation fault`。用 kernel32.GetCurrentThreadStackLimits
   取 high 再往下 0x200。
2. rb_eval_string_protect 的返回值不能按 `char*` 读（restype=c_char_p 会读到空）。
   要按 VALUE 读回来，再过 rb_string_value_cstr。

用法：python ruby_check.py <file1.rb> [file2.rb ...]
退出码：0 = 全部通过；1 = 有文件语法错误。
"""
import ctypes
import sys

DLL = r"C:\Program Files\SketchUp\SketchUp 2024\x64-ucrt-ruby320.dll"

CHECK_TEMPLATE = """
begin
  RubyVM::InstructionSequence.compile(File.read(%q{__PATH__}), %q{__LABEL__})
  "OK"
rescue SyntaxError => e
  "SYNTAX_ERROR: " + e.message
rescue Exception => e
  "ERROR: " + e.class.to_s + ": " + e.message
end
"""


def init_ruby():
    lib = ctypes.CDLL(DLL)
    lib.ruby_sysinit.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.POINTER(ctypes.c_char_p))]
    lib.ruby_sysinit.restype = None
    lib.ruby_init_stack.argtypes = [ctypes.c_void_p]
    lib.ruby_init_stack.restype = None
    lib.ruby_init.argtypes = []
    lib.ruby_init.restype = None
    lib.ruby_init_loadpath.argtypes = []
    lib.ruby_init_loadpath.restype = None
    lib.rb_eval_string_protect.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_int)]
    lib.rb_eval_string_protect.restype = ctypes.c_void_p
    lib.rb_string_value_cstr.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
    lib.rb_string_value_cstr.restype = ctypes.c_char_p

    args = [b"ruby"]
    argc = ctypes.c_int(len(args))
    arr = (ctypes.c_char_p * len(args))(*args)
    p = ctypes.cast(arr, ctypes.POINTER(ctypes.c_char_p))
    lib.ruby_sysinit(ctypes.byref(argc), ctypes.byref(p))

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    low = ctypes.c_ulonglong(0)
    high = ctypes.c_ulonglong(0)
    kernel32.GetCurrentThreadStackLimits(ctypes.byref(low), ctypes.byref(high))
    lib.ruby_init_stack(ctypes.c_void_p(high.value - 0x200))
    lib.ruby_init()
    lib.ruby_init_loadpath()
    return lib


def evaluate(lib, code: str):
    state = ctypes.c_int(0)
    value = lib.rb_eval_string_protect(code.encode("utf-8"), ctypes.byref(state))
    if not value:
        return state.value, "<NULL result>"
    holder = ctypes.c_void_p(value)
    raw = lib.rb_string_value_cstr(ctypes.byref(holder))
    return state.value, (raw or b"").decode("utf-8", "replace")


def main(argv) -> int:
    if not argv:
        print("usage: python ruby_check.py <file.rb> [...]")
        return 2
    lib = init_ruby()
    failed = 0
    for path in argv:
        norm = path.replace("\\", "/")
        code = CHECK_TEMPLATE.replace("__PATH__", norm).replace("__LABEL__", norm)
        state, text = evaluate(lib, code)
        if text.strip() == "OK":
            print("OK    " + path)
        else:
            failed += 1
            print("FAIL  " + path)
            for line in text.strip().splitlines():
                print("      " + line)
        if state != 0:
            failed += 1
            print("      (ruby state=%d)" % state)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
