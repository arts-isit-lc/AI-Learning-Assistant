const { initializeConnection } = require("./lib.js");
const { CognitoIdentityProviderClient, AdminAddUserToGroupCommand } = require("@aws-sdk/client-cognito-identity-provider");

const { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;
let sqlConnection = global.sqlConnection;

// OPT-11: Client at module level, AdminGetUserCommand removed (email from event)
const client = new CognitoIdentityProviderClient();

/**
 * PostConfirmation Cognito trigger.
 *
 * This is the AUTHORITATIVE, server-side creation point for a user's "Users"
 * row. It fires exactly once when an account is confirmed and always runs
 * server-side, so row creation no longer depends on the best-effort,
 * error-swallowed client call to POST /student/create_user (which only fired on
 * the confirm-then-auto-sign-in path and left delayed-confirmation / manual
 * sign-in users with a CONFIRMED Cognito account but no DB row).
 *
 * Two responsibilities, each independently best-effort so a failure in one can
 * never break confirmation or block the other:
 *   1. Idempotently ensure the "Users" row exists (INSERT ... ON CONFLICT DO
 *      NOTHING). Existing rows win, so an instructor row pre-provisioned by the
 *      admin flow keeps its role and names.
 *   2. Add the user to the Cognito group matching their DB role (default
 *      "student"), preserving existing behavior.
 *
 * The handler ALWAYS returns the event — Cognito ignores other return shapes and
 * does not retry PostConfirmation, so failing it would only harm UX without
 * fixing anything. Failures are logged loudly for CloudWatch/alarms, and the
 * PostAuthentication trigger (adjustUserRoles) provides a self-heal net on the
 * user's next sign-in if the DB write here ever fails transiently.
 */
exports.handler = async (event) => {
  if (!sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
    sqlConnection = global.sqlConnection;
  }

  const { userName, userPoolId } = event;
  const email = event.request.userAttributes.email;
  // Names are carried from signup via Cognito standard attributes. They may be
  // absent (e.g. admin-created users, forgot-password confirmations) — that's
  // fine, the row is still created with NULL names.
  const givenName = event.request.userAttributes.given_name || null;
  const familyName = event.request.userAttributes.family_name || null;

  // Default role for a brand-new self-signup; overridden below if a row already
  // exists (e.g. an admin-provisioned instructor).
  let role = "student";

  // 1. Ensure the profile row exists (idempotent). Independent try/catch so a DB
  //    failure never blocks the Cognito group assignment below or confirmation.
  try {
    const dbUser = await sqlConnection`
      SELECT roles FROM "Users" WHERE user_email = ${email};
    `;
    const dbRoles = dbUser[0]?.roles || [];
    if (dbRoles.length > 0) {
      role = dbRoles[0];
    }

    await sqlConnection`
      INSERT INTO "Users" (user_email, username, first_name, last_name, preferred_name, time_account_created, roles, last_sign_in)
      VALUES (${email}, ${email}, ${givenName}, ${familyName}, ${givenName}, CURRENT_TIMESTAMP, ARRAY[${role}], CURRENT_TIMESTAMP)
      ON CONFLICT (user_email) DO NOTHING;
    `;
  } catch (err) {
    console.error("addStudentOnSignUp: failed to ensure Users row:", err);
  }

  // 2. Add the user to the Cognito group matching their role.
  try {
    const addUserToGroupCommand = new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: userName,
      GroupName: role,
    });
    await client.send(addUserToGroupCommand);
  } catch (err) {
    console.error("addStudentOnSignUp: failed to assign Cognito group:", err);
  }

  // Always return the event so confirmation succeeds regardless of the above.
  return event;
};
