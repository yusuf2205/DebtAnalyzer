import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { checkPasswordPolicy } from '../src/auth/auth.service';

describe('политика паролей', () => {
  it('принимает пароль от 4 символов (любых), отклоняет короче', () => {
    expect(() => checkPasswordPolicy('abc')).toThrow(/не менее 4/);
    expect(() => checkPasswordPolicy('')).toThrow();
    for (const ok of ['abcd', '1234', 'пароль', 'a b!']) expect(() => checkPasswordPolicy(ok)).not.toThrow();
  });
});

describe('конфигурация окружения', () => {
  // Docker Compose передаёт незаданные переменные пустыми строками (GOOGLE_REDIRECT_URI: ${GOOGLE_REDIRECT_URI:-})
  it('пустые значения необязательных переменных означают «не задано», а не ошибку', () => {
    const c = loadConfig({
      DATABASE_URL: 'postgresql://u:p@h:5432/d',
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_REDIRECT_URI: '', TOKEN_ENCRYPTION_KEY: '',
      INITIAL_ADMIN_EMAIL: '', INITIAL_ADMIN_PASSWORD: '',
    } as NodeJS.ProcessEnv);
    expect(c.google.oauthConfigured).toBe(false);
  });

  it('заданный, но некорректный URL по-прежнему отклоняется', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://u:p@h:5432/d', GOOGLE_REDIRECT_URI: 'не-url' } as NodeJS.ProcessEnv)).toThrow(/GOOGLE_REDIRECT_URI/);
  });
});
