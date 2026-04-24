const { initializeConnection } = require("./lib.js");
const { CognitoIdentityProviderClient, AdminAddUserToGroupCommand } = require("@aws-sdk/client-cognito-identity-provider");

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

  try {
    // Retrieve roles from the database
    const dbUser = await sqlConnection`
      SELECT roles FROM "Users" WHERE user_email = ${email};
    `;

    const dbRoles = dbUser[0]?.roles || [];

    // Determine the new Cognito group based on the roles
    const newGroupName = dbRoles.length > 0 ? dbRoles[0] : "student";

    // Add the user to the new group without removing existing groups
    const addUserToGroupCommand = new AdminAddUserToGroupCommand({
      UserPoolId: userPoolId,
      Username: userName,
      GroupName: newGroupName,
    });
    await client.send(addUserToGroupCommand);

    return event;
  } catch (err) {
    console.error("Error assigning user to group:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Internal Server Error",
      }),
    };
  }
};
