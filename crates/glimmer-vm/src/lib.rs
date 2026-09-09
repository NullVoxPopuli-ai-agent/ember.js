//! The Glimmer bytecode interpreter.
//!
//! Linear memory layout (byte addresses):
//!
//! ```text
//! | statics | instruction heap (grows up) | ... free ... | handle table (grows down) |
//! 0      HEAP_BASE                                                         memory end
//! ```
//!
//! The heap holds i32 instruction words. The handle table maps a handle to the
//! heap address where its block starts. Both regions grow into the free space
//! between them; when they meet, the memory grows and the table moves to the
//! new end of memory.

#![no_std]

mod syscalls;

use core::arch::wasm32::{memory_grow, memory_size, unreachable};
use core::ptr::copy;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unreachable()
}

extern "C" {
    static __heap_base: u8;
}

#[link(wasm_import_module = "env")]
extern "C" {
    #[link_name = "pushFrame"]
    fn push_frame(ra: i32);
    #[link_name = "popFrame"]
    fn pop_frame() -> i32;
    #[link_name = "invokeVirtual"]
    fn invoke_virtual() -> i32;
    #[link_name = "traceCall"]
    fn trace_call(handle: i32);
    #[link_name = "traceReturn"]
    fn trace_return();
}

const PAGE_BYTES: usize = 65536;
const WORD: usize = 4;
/// Operand reads look up to three words past the current instruction, so the
/// heap keeps this many spare words before the table.
const SLACK_WORDS: usize = 4;

const ARG_SHIFT: i32 = 8;
const TYPE_MASK: i32 = 0xff;
const OPERAND_LEN_MASK: i32 = 0x300;
const MACHINE_MASK: i32 = 0x400;

const OP_PUSH_FRAME: i32 = 0;
const OP_POP_FRAME: i32 = 1;
const OP_INVOKE_VIRTUAL: i32 = 2;
const OP_INVOKE_STATIC: i32 = 3;
const OP_JUMP: i32 = 4;
const OP_RETURN: i32 = 5;
const OP_RETURN_TO: i32 = 6;

static mut PC: i32 = -1;
static mut RA: i32 = -1;
static mut OP_SIZE: i32 = 0;
static mut TRACE: i32 = 0;

/// Number of instruction words written so far.
static mut HEAP_LEN: usize = 0;
/// Number of handles allocated so far.
static mut TABLE_LEN: usize = 0;

#[inline(always)]
fn heap_base() -> *mut i32 {
    unsafe { &__heap_base as *const u8 as usize as *mut i32 }
}

#[inline(always)]
fn memory_end() -> usize {
    memory_size(0) * PAGE_BYTES
}

#[inline(always)]
fn table_entry(handle: usize) -> *mut i32 {
    (memory_end() - WORD * (handle + 1)) as *mut i32
}

#[inline(always)]
fn heap_top_bytes() -> usize {
    heap_base() as usize + WORD * unsafe { HEAP_LEN + SLACK_WORDS }
}

#[inline(always)]
fn table_bottom_bytes() -> usize {
    memory_end() - WORD * unsafe { TABLE_LEN }
}

#[cold]
fn grow() {
    let old_end = memory_end();
    let pages = memory_size(0);
    if memory_grow(0, pages) == usize::MAX {
        unreachable();
    }
    let table_bytes = WORD * unsafe { TABLE_LEN };
    let new_end = memory_end();
    unsafe {
        copy(
            (old_end - table_bytes) as *const u8,
            (new_end - table_bytes) as *mut u8,
            table_bytes,
        );
    }
}

#[inline(always)]
fn ensure_room(extra_words: usize) {
    while heap_top_bytes() + WORD * extra_words > table_bottom_bytes() {
        grow();
    }
}

// ---- heap ----

#[export_name = "heapPush"]
pub extern "C" fn heap_push(value: i32) {
    ensure_room(1);
    unsafe {
        *heap_base().add(HEAP_LEN) = value;
        HEAP_LEN += 1;
    }
}

#[export_name = "heapGet"]
pub extern "C" fn heap_get(address: i32) -> i32 {
    unsafe { *heap_base().add(address as usize) }
}

#[export_name = "heapSet"]
pub extern "C" fn heap_set(address: i32, value: i32) {
    unsafe { *heap_base().add(address as usize) = value }
}

#[export_name = "heapSize"]
pub extern "C" fn heap_size() -> i32 {
    unsafe { HEAP_LEN as i32 }
}

// ---- handle table ----

#[export_name = "malloc"]
pub extern "C" fn malloc() -> i32 {
    ensure_room(1);
    unsafe {
        let handle = TABLE_LEN;
        TABLE_LEN += 1;
        *table_entry(handle) = HEAP_LEN as i32;
        handle as i32
    }
}

#[export_name = "getaddr"]
pub extern "C" fn getaddr(handle: i32) -> i32 {
    unsafe { *table_entry(handle as usize) }
}

#[export_name = "entries"]
pub extern "C" fn entries() -> i32 {
    unsafe { TABLE_LEN as i32 }
}

// ---- registers ----

#[export_name = "pc"]
pub extern "C" fn pc() -> i32 {
    unsafe { PC }
}

#[export_name = "ra"]
pub extern "C" fn ra() -> i32 {
    unsafe { RA }
}

#[export_name = "setPc"]
pub extern "C" fn set_pc(value: i32) {
    unsafe { PC = value }
}

#[export_name = "setRa"]
pub extern "C" fn set_ra(value: i32) {
    unsafe { RA = value }
}

#[export_name = "opSize"]
pub extern "C" fn op_size() -> i32 {
    unsafe { OP_SIZE }
}

#[export_name = "setTrace"]
pub extern "C" fn set_trace(value: i32) {
    unsafe { TRACE = value }
}

#[export_name = "setOpSize"]
pub extern "C" fn set_op_size(value: i32) {
    unsafe { OP_SIZE = value }
}

// ---- control flow ----

/// The absolute address `offset` words away from the current instruction.
#[export_name = "target"]
pub extern "C" fn target(offset: i32) -> i32 {
    unsafe { PC + offset - OP_SIZE }
}

#[export_name = "goto"]
pub extern "C" fn goto(offset: i32) {
    unsafe { PC = PC + offset - OP_SIZE }
}

#[export_name = "returnTo"]
pub extern "C" fn return_to(offset: i32) {
    unsafe { RA = PC + offset - OP_SIZE }
}

#[export_name = "call"]
pub extern "C" fn call(handle: i32) {
    unsafe {
        RA = PC;
        PC = *table_entry(handle as usize);
    }
}

#[export_name = "ret"]
pub extern "C" fn ret() {
    unsafe { PC = RA }
}

// ---- execution ----

/// The raw instruction word at `pc`, or -1 when the program is finished.
#[export_name = "fetch"]
pub extern "C" fn fetch() -> i32 {
    unsafe {
        if PC < 0 {
            -1
        } else {
            *heap_base().add(PC as usize)
        }
    }
}

#[inline(always)]
unsafe fn machine(ty: i32, op1: i32) {
    match ty {
        OP_PUSH_FRAME => push_frame(RA),
        OP_POP_FRAME => RA = pop_frame(),
        OP_INVOKE_VIRTUAL => {
            let handle = invoke_virtual();
            if handle >= 0 {
                if TRACE != 0 {
                    trace_call(handle);
                }
                call(handle);
            }
        }
        OP_INVOKE_STATIC => {
            if TRACE != 0 {
                trace_call(op1);
            }
            call(op1);
        }
        OP_JUMP => goto(op1),
        OP_RETURN => {
            if TRACE != 0 {
                trace_return();
            }
            ret();
        }
        OP_RETURN_TO => return_to(op1),
        _ => unreachable(),
    }
}

#[inline(always)]
unsafe fn execute_one(pc: i32) {
    let base = heap_base();
    let at = base.add(pc as usize);
    let raw = *at;
    let size = ((raw & OPERAND_LEN_MASK) >> ARG_SHIFT) + 1;
    OP_SIZE = size;
    PC = pc + size;
    let ty = raw & TYPE_MASK;
    let op1 = *at.add(1);
    if raw & MACHINE_MASK != 0 {
        machine(ty, op1);
    } else {
        syscalls::dispatch(ty, op1, *at.add(2), *at.add(3));
    }
}

/// Execute one instruction. Returns 0 when the program is finished.
#[export_name = "step"]
pub extern "C" fn step() -> i32 {
    unsafe {
        let pc = PC;
        if pc < 0 {
            return 0;
        }
        execute_one(pc);
        1
    }
}

/// Execute until `pc` is -1.
#[export_name = "run"]
pub extern "C" fn run() {
    unsafe {
        loop {
            let pc = PC;
            if pc < 0 {
                return;
            }
            execute_one(pc);
        }
    }
}
