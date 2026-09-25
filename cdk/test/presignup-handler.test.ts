/**
 * Behavior tests for the Cognito PreSignup handler (cdk/lambda/lib/preSignup.js).
 *
 * The handler gates account creation on an SSM-backed allowlist: a signup is
 * permitted when EITHER the email's domain is in /AILA/AllowedEmailDomains OR
 * the full address is in /AILA/AllowedEmailAddresses. Both parameters are read
 * in one GetParameters (plural) call; a missing AllowedEmailAddresses parameter
 * is treated as an empty list so the individual allowlist stays optional.
 *
 * @aws-sdk/client-ssm is not a local dependency (it ships in the Lambda Node.js
 * runtime), so it is virtually mocked here.
 */

const mockSend = jest.fn();

jest.mock(
  '@aws-sdk/client-ssm',
  () => ({
    SSMClient: jest.fn(() => ({ send: mockSend })),
    GetParametersCommand: jest.fn((input) => ({ __type: 'GetParameters', input })),
  }),
  { virtual: true }
);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/lib/preSignup');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GetParametersCommand } = require('@aws-sdk/client-ssm');

const DOMAINS_PARAM = '/AILA/AllowedEmailDomains';
const ADDRESSES_PARAM = '/AILA/AllowedEmailAddresses';

const GENERIC_ERROR = 'Error validating email domain during pre-signup.';

const makeEvent = (email: string) => ({
  request: { userAttributes: { email } },
});

/** Stub the GetParameters response. Pass `undefined` to omit a parameter (as SSM does for a missing name). */
const stubParams = (values: Record<string, string | undefined>) => {
  mockSend.mockResolvedValue({
    Parameters: Object.entries(values)
      .filter(([, v]) => v !== undefined)
      .map(([Name, Value]) => ({ Name, Value })),
  });
};

beforeAll(() => {
  process.env.ALLOWED_EMAIL_DOMAINS = DOMAINS_PARAM;
  process.env.ALLOWED_EMAIL_ADDRESSES = ADDRESSES_PARAM;
});

beforeEach(() => {
  mockSend.mockReset();
  (GetParametersCommand as jest.Mock).mockClear();
});

describe('preSignup handler — domain + individual-email allowlist', () => {
  test('allows a signup whose domain is in the domain allowlist', async () => {
    stubParams({
      [DOMAINS_PARAM]: 'ubc.ca,student.ubc.ca',
      [ADDRESSES_PARAM]: '',
    });
    const event = makeEvent('prof@ubc.ca');
    await expect(handler(event)).resolves.toBe(event);
  });

  test('allows a signup whose exact address is in the individual allowlist even when its domain is NOT allowed', async () => {
    stubParams({
      [DOMAINS_PARAM]: 'ubc.ca,student.ubc.ca',
      [ADDRESSES_PARAM]: 'external.collab@gmail.com,jane.doe@example.org',
    });
    const event = makeEvent('external.collab@gmail.com');
    await expect(handler(event)).resolves.toBe(event);
  });

  test('rejects a signup that matches neither the domain nor the individual allowlist', async () => {
    stubParams({
      [DOMAINS_PARAM]: 'ubc.ca,student.ubc.ca',
      [ADDRESSES_PARAM]: 'jane.doe@example.org',
    });
    await expect(handler(makeEvent('stranger@gmail.com'))).rejects.toThrow(GENERIC_ERROR);
  });

  test('matches addresses and domains case-insensitively (with surrounding whitespace tolerated)', async () => {
    stubParams({
      [DOMAINS_PARAM]: 'UBC.ca',
      [ADDRESSES_PARAM]: ' External.Collab@Gmail.com , jane.doe@example.org ',
    });
    // Uppercased incoming email still matches the lowercased list entry.
    await expect(handler(makeEvent('EXTERNAL.COLLAB@gmail.com'))).resolves.toBeDefined();
    // And the domain check is likewise case-insensitive.
    await expect(handler(makeEvent('Prof@UBC.CA'))).resolves.toBeDefined();
  });

  test('treats a missing AllowedEmailAddresses parameter as an empty list (domain check still enforced)', async () => {
    // SSM omits the parameter entirely when it does not exist yet.
    stubParams({ [DOMAINS_PARAM]: 'ubc.ca' });

    // Domain-allowed signup still succeeds.
    await expect(handler(makeEvent('prof@ubc.ca'))).resolves.toBeDefined();

    // Non-domain address is denied because there is no individual allowlist.
    await expect(handler(makeEvent('external.collab@gmail.com'))).rejects.toThrow(GENERIC_ERROR);
  });

  test('rejects when the email has no domain part', async () => {
    stubParams({ [DOMAINS_PARAM]: 'ubc.ca', [ADDRESSES_PARAM]: '' });
    await expect(handler(makeEvent('not-an-email'))).rejects.toThrow(GENERIC_ERROR);
  });

  test('requests both parameter names in a single GetParameters call', async () => {
    stubParams({ [DOMAINS_PARAM]: 'ubc.ca', [ADDRESSES_PARAM]: '' });
    await handler(makeEvent('prof@ubc.ca'));

    expect(GetParametersCommand as jest.Mock).toHaveBeenCalledTimes(1);
    const input = (GetParametersCommand as jest.Mock).mock.calls[0][0];
    expect(input.Names).toEqual([DOMAINS_PARAM, ADDRESSES_PARAM]);
    expect(input.WithDecryption).toBe(true);
  });
});
