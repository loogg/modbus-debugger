-- Native continuations for the graph-specific blocks compiled into this chunk.
-- Lua retains control state per event. Device effects return to the host.
local blocks = { [0] = function(_, done) return done end }
local flows = {}
local startup

local function done() return "done" end
local function unhandled() return "unhandled" end

local function notify(f, action, continuation)
  return function()
    f.resume = continuation
    return action
  end
end

local function invoke(group, f, next_step, fail, leave)
  return blocks[group](f, notify(f, "leave_call", next_step),
    notify(f, "leave_call", fail), notify(f, "leave_call", leave))()
end

local function protected(body, handler, f, next_step, fail, leave)
  local function recover()
    if handler == 0 then return fail() end
    f.resume = blocks[handler](f, notify(f, "leave_handler", next_step),
      notify(f, "leave_handler", fail), notify(f, "leave_handler", leave))
    return "enter_handler"
  end
  return blocks[body](f, next_step, recover, leave)()
end

local function loop(body, remaining, conditional, group, index, f, next_step, fail)
  local iteration
  local function boundary()
    if remaining == 0 then return next_step() end
    f.resume = iteration
    return "boundary", group, index
  end
  local function enter(reply)
    if reply == "error" then return fail() end
    if reply == "exit_loop" then return next_step() end
    if remaining > 0 then remaining = remaining - 1 end
    return blocks[body](f, boundary, fail, next_step)()
  end
  iteration = function()
    if conditional then
      f.resume = enter
      return "test", group, index
    end
    return enter()
  end
  return iteration()
end

function open_flow(slot, group)
  local f = {}
  f.resume = blocks[group](f, done, unhandled, unhandled)
  flows[slot] = f
end

function close_flow(slot)
  flows[slot] = nil
end

function advance_flow(slot, ...)
  return flows[slot].resume(...)
end

function sleep_ms(ms)
  if coroutine.running() ~= startup or not coroutine.isyieldable() then
    return handle_fault("sleep_ms 仅允许在 on_start 协程中调用")
  end
  return coroutine.yield("sleep", ms)
end

function startup_flow()
  startup = coroutine.running()
  local reply, choice = "next"
  while true do
    local action, group, index = advance_flow(0, reply, choice)
    if action == "done" or action == "unhandled" then return action end
    reply, choice = coroutine.yield(action, group, index)
    if reply == "sleep" then reply, choice = sleep_ms(choice) end
  end
end
