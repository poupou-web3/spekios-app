import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { AccountCreation, testAccount } from '../src/account-creation.js';
import { explorationFixture } from '../src/exploration-fixture.js';

test('generated accounts use independent strong passwords and require a real email-shaped identity',()=>{
  const a=testAccount('agent@example.test','Spekios QA'),b=testAccount('agent@example.test','Spekios QA');
  assert.ok(a.password.length>=24);assert.notEqual(a.password,b.password);
  for(const email of ['', 'not-an-email','agent@example.test\nother','<agent>@example.test'])assert.throws(()=>testAccount(email,'QA'));
  assert.throws(()=>testAccount('agent@example.test',''));
});

test('native account creation stays private, bounded and restricted to observed registration forms',async t=>{
  const fixture=await explorationFixture(),browser=await chromium.launch({headless:true,chromiumSandbox:false});
  try{
    await t.test('finds signup from login, fills credentials and terms, and submits exactly once',async()=>{
      const context=await browser.newContext(),page=await context.newPage(),account=testAccount('agent@example.test','Spekios QA');
      await page.goto(fixture.url+'/auth/login');const driver=new AccountCreation(account,fixture.url);
      assert.equal(await driver.step(page),'progress');assert.equal(new URL(page.url()).pathname,'/auth/register');
      assert.equal(await driver.step(page),'progress');assert.equal(await driver.step(page),'ready');
      assert.deepEqual(fixture.createdAccounts,[account]);assert.equal(await driver.step(page),'ready');assert.equal(fixture.createdAccounts.length,1);
      await context.close();
    });
    await t.test('verification, unsupported required fields and external providers require human help',async()=>{
      const page=await browser.newPage();await page.goto(fixture.url+'/auth/register');
      const driver=()=>new AccountCreation(testAccount('agent@example.test','Spekios QA'),fixture.url);
      await page.setContent('<input autocomplete="one-time-code">');assert.equal(await driver().step(page),'verification_required');
      await page.setContent('<div data-sitekey="captcha" style="height:100px;width:100px"></div>');assert.equal(await driver().step(page),'verification_required');
      await page.setContent('<form method="post" action="/auth/register"><input type="email" required><input name="tax_number" required><button>Create account</button></form>');
      assert.equal(await driver().step(page),'unsupported_signup');assert.equal(await page.locator('input[type=email]').inputValue(),'');
      await page.setContent('<a href="https://outside.invalid/signup">Create account</a>');assert.equal(await driver().step(page),'signup_not_found');
      await page.setContent('<form method="post" action="/newsletter"><input type="email"><button>Get started</button></form>');assert.equal(await driver().step(page),'signup_not_found');
      await page.setContent('<form action="https://outside.invalid/signup"><input type="email"><button>Create account</button></form>');
      assert.equal(await driver().step(page),'unsupported_signup');
      for(const form of ['<form action="/auth/register">','<form method="post" action="/auth/register">']){
        await page.setContent(form+'<input type="email"><input type="password"><button formmethod="get">Create account</button></form>');
        assert.equal(await driver().step(page),'unsupported_signup');assert.equal(await page.locator('input[type=password]').inputValue(),'');
      }
      await page.close();
    });
    await t.test('a form that stays unchanged is never automatically submitted twice',async()=>{
      const page=await browser.newPage();await page.goto(fixture.url+'/auth/register');
      await page.setContent('<form method="post" action="/auth/register" onsubmit="event.preventDefault();window.submits=(window.submits||0)+1"><input type="email" required><input type="password" required><button>Create account</button></form>');
      const driver=new AccountCreation(testAccount('agent@example.test','Spekios QA'),fixture.url);
      assert.equal(await driver.step(page),'progress');assert.equal(await driver.step(page),'signup_not_completed');
      assert.equal(await page.evaluate('window.submits'),1);await page.close();
    });
  }finally{await browser.close();await fixture.close();}
});
