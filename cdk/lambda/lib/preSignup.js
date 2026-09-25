const { SSMClient, GetParametersCommand } = require("@aws-sdk/client-ssm");

// Normalize a comma-separated SSM value into a lowercased, trimmed, non-empty list.
const parseList = (value) =>
  (value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

exports.handler = async (event) => {
  const ssmClient = new SSMClient();
  const domainsParam = process.env.ALLOWED_EMAIL_DOMAINS;
  const addressesParam = process.env.ALLOWED_EMAIL_ADDRESSES;

  try {
    // Single call for both parameters. GetParameters (plural) returns a missing
    // parameter under InvalidParameters instead of throwing, so the individual
    // address list stays optional — signups keep working before it is seeded.
    const { Parameters = [] } = await ssmClient.send(
      new GetParametersCommand({
        Names: [domainsParam, addressesParam],
        WithDecryption: true,
      })
    );
    const byName = Object.fromEntries(
      Parameters.map((p) => [p.Name, p.Value])
    );

    const allowedDomains = parseList(byName[domainsParam]);
    const allowedAddresses = parseList(byName[addressesParam]);

    const email = (event.request.userAttributes.email || "").trim().toLowerCase();
    const emailDomain = email.split("@")[1];

    const domainAllowed = Boolean(emailDomain) && allowedDomains.includes(emailDomain);
    const addressAllowed = allowedAddresses.includes(email);

    if (!domainAllowed && !addressAllowed) {
      throw new Error(`Signup not allowed for email domain: ${emailDomain}`);
    }

    return event;
  } catch (error) {
    console.error(error);
    throw new Error("Error validating email domain during pre-signup.");
  }
};
