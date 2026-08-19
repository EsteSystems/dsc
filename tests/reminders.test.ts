import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReminderDetector } from "../src/reminders.js";

describe("ReminderDetector", () => {
  it("is quiet before any events", () => {
    const d = new ReminderDetector();
    assert.equal(d.getReminder(), null);
  });

  it("arms once after a file edit and stays quiet until the state changes", () => {
    const d = new ReminderDetector();
    d.onToolEnd("edit_file", "ok: edited", false, 10);
    assert.match(d.getReminder()!, /Run verify/);
    assert.equal(d.getReminder(), null);
  });

  it("clears the edit reminder after a passing verify", () => {
    const d = new ReminderDetector();
    d.onToolEnd("write_file", "ok: created", false, 10);
    d.getReminder(); // emit the edit reminder
    d.onToolEnd("verify", "verification:\nexit_code: 0", false, 1000);
    assert.equal(d.getReminder(), null);
  });

  it("re-arms after a failing verify so the model is told again", () => {
    const d = new ReminderDetector();
    d.onToolEnd("multi_edit", "ok: applied", false, 10);
    d.getReminder();
    d.onToolEnd("verify", "verification:\nexit_code: 1", false, 1000);
    assert.match(d.getReminder()!, /Run verify/);
  });

  it("arms once after a long-running bash command", () => {
    const d = new ReminderDetector();
    d.onToolEnd("bash", "exit_code: 0", false, 31_000);
    assert.match(d.getReminder()!, /ran for 31s/);
    assert.equal(d.getReminder(), null);
  });

  it("does not arm for short bash commands", () => {
    const d = new ReminderDetector();
    d.onToolEnd("bash", "exit_code: 0", false, 29_000);
    assert.equal(d.getReminder(), null);
  });
});
