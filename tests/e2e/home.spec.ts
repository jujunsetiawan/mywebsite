import { expect, test } from '@playwright/test';

for (const lang of ['id', 'en'] as const) {
  test(`/${lang}/ renders the placeholder home with lang="${lang}"`, async ({ page }) => {
    const response = await page.goto(`/${lang}/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Jujun Setiawan');
  });
}
