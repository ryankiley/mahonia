// The privacy policy says how long a list is kept, and the numbers it says are the ones
// the nightly cron runs on (shared/retention.ts).
//
// The page writes them out as words rather than reading the constants. Its "Last
// updated" date moves when its words do (scripts/stamp-legal-dates.mjs), so a window
// changed only in shared/retention.ts would change the policy and leave the date where
// it was. Here a changed window fails until the page says the new number, and that edit
// is what moves the date.
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import Legal from "~/pages/legal.vue";
import { LIST_PURGE_GRACE_DAYS, LIST_REAP_STALE_DAYS } from "~~/shared/retention";

describe("the privacy policy's retention windows", () => {
  it("are the ones the cron keeps lists by", () => {
    const text = mount(Legal, { global: { stubs: { SiteTopbar: true } } }).text();
    expect(text).toContain(`hasn’t been edited for ${LIST_REAP_STALE_DAYS} days is removed`);
    expect(text).toContain(`is held for ${LIST_PURGE_GRACE_DAYS} days before it’s deleted for good`);
  });
});
