const { initializeConnection } = require("./lib.js");
const { CognitoIdentityProviderClient, AdminListGroupsForUserCommand, AdminAddUserToGroupCommand, AdminRemoveUserFromGroupCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;
let sqlConnection = global.sqlConnection;

// OPT-11: Client at module level, AdminGetUserCommand removed (email from event)
const client = new CognitoIdentityProviderClient();

exports.handler = async (event) => {
  if (!sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
    sqlConnection = global.sqlConnection;
  }

  const { userName, userPoolId } = event;
  const email = event.request.userAttributes.email;
  // Carried from signup via Cognito standard attributes; may be absent.
  const givenName = event.request.userAttributes.given_name || null;
  const familyName = event.request.userAttributes.family_name || null;

  try {
    // Get user groups from Cognito
    const userGroupsCommand = new AdminListGroupsForUserCommand({
      UserPoolId: userPoolId,
      Username: userName,
    });
    const userGroupsResponse = await client.send(userGroupsCommand);
    const cognitoRoles = userGroupsResponse.Groups.map(group => group.GroupName);

    // Retrieve roles from the database
    const dbUser = await sqlConnection`
      SELECT roles FROM "Users"
      WHERE user_email = ${email};
    `;

    // Self-heal net: a confirmed, authenticated user with no "Users" row. This
    // happens when the client-side create never ran (e.g. the account was
    // confirmed in a later session, so the confirm->auto-sign-in path in
    // Login.jsx didn't fire), or if the PostConfirmation DB write failed
    // transiently. This trigger fires ONLY after Cognito has fully
    // authenticated the user, so creating the row here grants nothing beyond
    // what Cognito already authenticated — it is post-auth bookkeeping, not an
    // auth gate. The seed role mirrors Cognito's server-side group truth (never
    // client input) and defaults to "student"; ON CONFLICT keeps it idempotent
    // under concurrent logins. We return early so the reconciliation below
    // doesn't operate on a row we just created to match Cognito.
    if (dbUser.length === 0) {
      let seedRole = "student";
      if (cognitoRoles.includes("admin")) {
        seedRole = "admin";
      } else {
        const nonAdmin = cognitoRoles.find(r => ["instructor", "student"].includes(r));
        if (nonAdmin) seedRole = nonAdmin;
      }

      await sqlConnection`
        INSERT INTO "Users" (user_email, username, first_name, last_name, preferred_name, time_account_created, roles, last_sign_in)
        VALUES (${email}, ${email}, ${givenName}, ${familyName}, ${givenName}, CURRENT_TIMESTAMP, ARRAY[${seedRole}], CURRENT_TIMESTAMP)
        ON CONFLICT (user_email) DO NOTHING;
      `;
      console.log(`adjustUserRoles: self-healed missing Users row for ${email} (role ${seedRole})`);
      return event;
    }

    const dbRoles = dbUser[0]?.roles || [];

    // Handle role synchronization between Cognito and DB
    if (cognitoRoles.includes('admin')) {
      // If Cognito has admin, make sure DB is also admin
      if (!dbRoles.includes('admin')) {
        await sqlConnection`
          UPDATE "Users"
          SET roles = array_append(roles, 'admin')
          WHERE user_email = ${email};
        `;
        console.log('DB roles updated to include admin');
      }
    } else if (cognitoRoles.some(role => ['instructor', 'student'].includes(role))) {
      const cognitoNonAdminRole = cognitoRoles.find(role => ['instructor', 'student'].includes(role));
      
      if (dbRoles.includes('admin')) {
        // If DB has admin but Cognito is not admin, update DB role to match Cognito
        await sqlConnection`
          UPDATE "Users"
          SET roles = ${[cognitoNonAdminRole]}
          WHERE user_email = ${email};
        `;
        console.log(`DB roles updated to match Cognito (${cognitoNonAdminRole})`);
      } else if (dbRoles.length && dbRoles[0] !== cognitoNonAdminRole) {
        // If DB role doesn't match Cognito and isn't admin, update Cognito to match DB
        const removeFromGroupCommand = new AdminRemoveUserFromGroupCommand({
          UserPoolId: userPoolId,
          Username: userName,
          GroupName: cognitoNonAdminRole,
        });
        const addToGroupCommand = new AdminAddUserToGroupCommand({
          UserPoolId: userPoolId,
          Username: userName,
          GroupName: dbRoles[0],
        });

        await client.send(removeFromGroupCommand);
        await client.send(addToGroupCommand);

        console.log(`Cognito roles updated to match DB (${dbRoles[0]})`);
      }
    }

    return event;
  } catch (err) {
    console.error(err);
    return event;
  }
};
