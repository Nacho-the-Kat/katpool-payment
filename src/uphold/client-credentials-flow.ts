import axios from 'axios';
import { UPHOLD_BASE_URL } from '../trxs/uphold';

// Authentication credentials.
const auth = Buffer.from(process.env.CLIENT_ID + ':' + process.env.CLIENT_SECRET).toString(
  'base64'
);

function formatError(error) {
  const responseStatus = `${error.response.status} (${error.response.statusText})`;

  console.log(
    `Request failed with HTTP status code ${responseStatus}`,
    JSON.stringify(
      {
        url: error.config.url,
        response: error.response.data,
      },
      null,
      2
    )
  );

  throw error;
}

export async function getUpholdAccessToken() {
  try {
    const response = await axios.request({
      method: 'POST',
      url: `${UPHOLD_BASE_URL}oauth2/token`,
      data: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'users:* transactions:* cards:read',
        /*
          TODO: Uphold Scope data is not available for enterprise API. 
          These scopes are added from https://docs.uphold.com/#permissions
        */
      }),
      headers: {
        Authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    });

    return response.data;
  } catch (error) {
    formatError(error);
  }
}

export async function getUserInfo(accessToken) {
  try {
    const response = await axios.request({
      method: 'GET',
      url: `${UPHOLD_BASE_URL}/accounts`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return response.data;
  } catch (error) {
    formatError(error);
  }
}
