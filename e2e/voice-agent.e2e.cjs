/**
 * Browser test of the real experience against a running `npm run dev` (APP_URL, default
 * http://localhost:3000). It drives the UI as an operator (Ada, owner) and a staff member (Grace),
 * calls the business from the simulator phone, and saves screenshots to docs/screenshots/.
 *
 *   npm run dev                      # in one terminal (fresh state: rm -rf .feltkit/development)
 *   npm run test:e2e                 # in another; DASHBOARD_URL=<the Dashboard link> adds Studio shots
 */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");

const APP = process.env.APP_URL ?? "http://localhost:3000";
const OUT = "docs/screenshots";
mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const step = (name) => console.log(`• ${name}`);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error("page error:", e.message));
    const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
    // In-app navigation (no reload): a reload would close the simulator phone and end its call.
    const nav = (hash) => page.evaluate((h) => { location.hash = h; }, hash);

    step("sign in as Ada and see onboarding");
    await page.goto(`${APP}/?as=ada`);
    await page.getByText("Try it with a sample business").waitFor();
    await shot("01-onboarding");

    step("open the sample business → setup checklist");
    await page.getByRole("button", { name: "Open sample business" }).click();
    await page.getByRole("heading", { name: "Setup & health" }).waitFor();
    await page.getByText("Ready ✓").waitFor({ timeout: 15000 });
    await shot("02-setup-ready");

    step("call the business from the simulator phone and book an appointment");
    await page.getByRole("button", { name: /Simulator phone/ }).click();
    await page.getByLabel("Speak aloud").uncheck().catch(() => {});
    await page.getByRole("button", { name: /^📞 Call/ }).click();
    const phone = page.locator(".phone");
    await phone.getByText(/Thanks for calling/).waitFor();
    await page.getByLabel("Speak aloud").uncheck();
    const say = async (text, expect) => {
      await phone.getByLabel("Say").fill(text);
      await phone.getByLabel("Say").press("Enter");
      await phone.getByText(expect).last().waitFor();
    };
    await say("I'd like to book an appointment tomorrow", /earliest I have is/);
    await say("the first one", /name for the booking/);
    await say("It's Taylor Morgan", /You're all set for/);
    await phone.getByText(/texted you a confirmation/).waitFor();
    await nav(`#/live`);
    await page.locator(".transcript").getByText("It's Taylor Morgan").waitFor();
    await page.locator(".transcript").getByText(/Booked/).waitFor();
    await shot("03-live-call");

    await nav("#/team");
    await page.getByRole("heading", { name: "Team" }).waitFor();
    await page.waitForTimeout(500);
    await shot("10-team");
    await nav("#/live");
    await page.locator(".transcript").waitFor();

    step("hang up; the conversation shows the call, its summary and the text confirmation");
    await phone.getByRole("button", { name: "Hang up" }).click();
    await nav(`#/inbox`);
    await page.locator(".call-card").first().waitFor();
    await page.locator(".bubble.outbound").filter({ hasText: /confirmed for/ }).waitFor();
    await page.locator(".call-card").filter({ hasText: /appointment booked/ }).waitFor({ timeout: 10000 });
    await shot("04-inbox-call-and-confirmation");

    step("text the business; the agent answers");
    await phone.getByRole("button", { name: /^Texts/ }).click();
    await phone.getByLabel("Text message").fill("What are your hours?");
    await phone.getByRole("button", { name: "Send" }).click();
    await phone.locator(".pl.agent").filter({ hasText: /hours are/ }).waitFor({ timeout: 10000 });
    await page.locator(".bubble.inbound").filter({ hasText: "What are your hours?" }).waitFor();
    await shot("05-sms-agent-reply");

    step("staff reply by text and add a note");
    await page.getByLabel("Reply by text").fill("Thanks Taylor, see you tomorrow!");
    await page.getByRole("button", { name: "Send text" }).click();
    await page.locator(".bubble.outbound").filter({ hasText: "see you tomorrow" }).waitFor();
    await phone.locator(".pl.agent").filter({ hasText: "see you tomorrow" }).waitFor();
    await page.getByRole("button", { name: "Close phone" }).click();

    step("a live call: operator says a line, takes over, and hangs up");
    await page.getByRole("button", { name: /Simulator phone/ }).click();
    await page.getByLabel("Speak aloud").uncheck().catch(() => {});
    await phone.getByRole("button", { name: "Call", exact: true }).click();
    await page.getByRole("button", { name: /^📞 Call/ }).click();
    await phone.getByText(/Thanks for calling|Hi Taylor/).first().waitFor();
    await nav(`#/live`);
    await page.getByLabel("Say to the caller").fill("Hi Taylor, this is Ada at the front desk.");
    await page.getByRole("button", { name: "Say", exact: true }).click();
    await phone.getByText("Hi Taylor, this is Ada at the front desk.").waitFor();
    await page.getByRole("button", { name: "Take over" }).click();
    await page.getByText("operator has the call").waitFor();
    await shot("06-operator-intervention");
    await page.locator(".controls").getByRole("button", { name: "Hang up" }).click();
    await phone.getByText("The agent ended the call.").waitFor();
    await page.getByRole("button", { name: "Close phone" }).click();

    step("agents, numbers, settings, follow-ups, activity, overview");
    await nav(`#/agents`);
    await page.getByText("Capabilities (what this agent may do)").waitFor();
    await shot("07-agent-config");
    await nav(`#/numbers`);
    await page.getByText("Twilio webhooks for a number").waitFor();
    await shot("08-phone-numbers");
    await nav(`#/settings`);
    await page.getByText("Communication policy").waitFor();
    await shot("09-settings-policy");
    await nav(`#/activity`);
    await page.getByText("appointment.booked").first().waitFor();
    await shot("11-activity-audit");
    await nav(`#/followups`);
    await page.getByText("Upcoming appointments").waitFor();
    await shot("12-followups");
    await nav(`#/overview`);
    await page.getByText("Recent calls").waitFor();
    const calls = await page.locator(".stat").filter({ hasText: "Calls (24h)" }).locator(".stat-value").textContent();
    assert.ok(Number(calls) >= 2, `calls today: ${calls}`);
    await shot("00-overview");

    step("configuration without code: change the agent's greeting and see it on the next call");
    await nav(`#/agents`);
    await page.getByLabel("Greeting").fill("Good day from Acme Dental! What can I do for you?");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText(/Agent saved/).waitFor();
    await page.getByRole("button", { name: /Simulator phone/ }).click();
    await page.getByLabel("Speak aloud").uncheck().catch(() => {});
    await page.getByRole("button", { name: /^📞 Call/ }).click();
    await phone.getByText(/Good day from Acme Dental/).waitFor();
    await phone.getByRole("button", { name: "Hang up" }).click();
    await page.getByRole("button", { name: "Close phone" }).click();

    step("dark mode and a phone-sized screen");
    const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark", storageState: await ctx.storageState() });
    const dp = await dark.newPage();
    await dp.goto(`${APP}/#/live`);
    await dp.locator(".transcript").waitFor();
    await dp.screenshot({ path: `${OUT}/13-live-dark.png` });
    await dark.close();
    const mobile = await browser.newContext({ ...require("playwright").devices["iPhone 13"], storageState: await ctx.storageState() });
    const mp = await mobile.newPage();
    await mp.goto(`${APP}/#/inbox`);
    await mp.locator(".bubble").first().waitFor();
    await mp.screenshot({ path: `${OUT}/14-mobile-inbox.png` });
    await mobile.close();

    if (process.env.DASHBOARD_URL) {
      step("FeltKit Studio: configuration, credentials, models");
      const sp = await ctx.newPage();
      await sp.goto(process.env.DASHBOARD_URL);
      await sp.waitForTimeout(2500);
      await sp.screenshot({ path: `${OUT}/20-studio-overview.png` });
      for (const [hash, name] of [["#/services/configuration", "21-studio-configuration"], ["#/models", "22-studio-models"], ["#/data", "23-studio-data"], ["#/capabilities", "24-studio-capabilities"], ["#/services", "25-studio-services"]]) {
        await sp.goto(`${APP}/_feltkit/${hash}`);
        await sp.waitForTimeout(2000);
        await sp.screenshot({ path: `${OUT}/${name}.png` });
      }
    }
    console.log("\nAll browser checks passed. Screenshots in docs/screenshots/.");
  } catch (e) {
    console.error(e);
    for (const c of browser.contexts()) for (const p of c.pages()) await p.screenshot({ path: `/tmp/claude-0/e2e-failure-${Math.random().toString(36).slice(2, 6)}.png` }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
