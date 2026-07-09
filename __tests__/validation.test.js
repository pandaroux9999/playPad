const { validatePassword, validateEmail } = require('../Site/server/server');

describe('validatePassword', () => {
  test('rejects password shorter than 8 characters', () => {
    expect(validatePassword('Ab1')).toBe('Le mot de passe doit contenir au moins 8 caractères');
    expect(validatePassword('Abcdef1')).toBe('Le mot de passe doit contenir au moins 8 caractères');
  });

  test('rejects password without uppercase letter', () => {
    expect(validatePassword('abcdef123')).toBe('Le mot de passe doit contenir au moins une majuscule');
  });

  test('rejects password without lowercase letter', () => {
    expect(validatePassword('ABCDEF123')).toBe('Le mot de passe doit contenir au moins une minuscule');
  });

  test('rejects password without digit', () => {
    expect(validatePassword('Abcdefgh')).toBe('Le mot de passe doit contenir au moins un chiffre');
  });

  test('accepts valid password', () => {
    expect(validatePassword('Abcdef123')).toBeNull();
    expect(validatePassword('MyP@ssw0rd!')).toBeNull();
    expect(validatePassword('Valid12345')).toBeNull();
  });
});

describe('validateEmail', () => {
  test('accepts valid email', () => {
    expect(validateEmail('test@example.com')).toBe(true);
    expect(validateEmail('user.name+tag@domain.co')).toBe(true);
  });

  test('rejects invalid email', () => {
    expect(validateEmail('')).toBe(false);
    expect(validateEmail('notanemail')).toBe(false);
    expect(validateEmail('@domain.com')).toBe(false);
    expect(validateEmail('user@')).toBe(false);
  });
});
