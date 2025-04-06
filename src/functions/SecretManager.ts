import { app, InvocationContext,EventGridEvent, HttpRequest, HttpResponseInit } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import * as nodemailer from "nodemailer";
import * as qrcode from "qrcode";
import * as appInsights from "applicationinsights";
import {  } from "@azure/eventgrid";


// Initialize Application Insights
appInsights.setup().start();
const telemetryClient = appInsights.defaultClient;

const keyVaultUrl = process.env.KEYVAULT_URL || "";
const secretClient = new SecretClient(keyVaultUrl, new DefaultAzureCredential());

export async function SecretManager(event: EventGridEvent, context: InvocationContext): Promise<void> {

    context.log(`Event received: ${JSON.stringify(event)}`);

    try {
        const { data } = event;
        const secretName = data?.objectName as string;

        // Retrieve secret from Azure Key Vault
        const secret = await secretClient.getSecret(secretName);
        const { value: secretValue, properties: { tags: metadata } } = secret;

        if (!metadata) {
            throw new Error("Metadata is missing for the secret.");
        }

        const recipientEmail = metadata.recipientEmail;
        if (!recipientEmail) {
            throw new Error("Recipient email is missing in metadata.");
        }

        // Generate a unique link and QR code for secret retrieval
        const retrievalLink = `${process.env.RETRIEVAL_URL}?secret=${secretName}`;
        const qrCodeData = await qrcode.toDataURL(retrievalLink);

        // Send email notification
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: recipientEmail,
            subject: "Your Secret is Ready",
            html: `<p>You can retrieve your secret using the link below:</p>
                   <a href="${retrievalLink}">${retrievalLink}</a>
                   <p>Or scan the QR code:</p>
                   <img src="${qrCodeData}" alt="QR Code" />`,
        });

        // Log the event
        telemetryClient.trackEvent({ name: "SecretRetrieved", properties: { secretName, recipientEmail } });

        context.log("Notification sent successfully.");
    } catch (error: any) {
        context.log(`Error processing event: ${error.message}`);
        telemetryClient.trackException({ exception: error });
    }
}

app.eventGrid('SecretManager', {
    handler: SecretManager
});

// Azure Function to serve the retrieval form
export const getRetrieveForm = async (req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    return {
        headers: { "Content-Type": "text/html" },
        body: `
            <html>
                <body>
                    <h1>Retrieve Your Secret</h1>
                    <form method="POST" action="/api/retrievepost">
                        <label for="secretName">Secret Name:</label>
                        <input type="text" id="secretName" name="secretName" required />
                        <button type="submit">Retrieve</button>
                    </form>
                </body>
            </html>
        `,
    };
};

app.http('retrieve', {
    methods: ['GET'],
    handler: getRetrieveForm
});

// Azure Function to handle secret retrieval
export const postRetrieveForm = async ( req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    let secretName: string | undefined;
    
    try {
        const body= await req.formData(); 
        secretName = body.get('secretName') as string;
        } catch (error) {
            return {
            status: 400,
            body: "Invalid request body. Please provide a valid JSON object."
        };
    }

    if (!secretName) {
        return {
            status: 400,
            body: "Secret name is required."
        };
    }

    try {
        // Retrieve secret from Azure Key Vault
        const secret = await secretClient.getSecret(secretName);
        const secretValue = secret.value;

        return {
            headers: { "Content-Type": "text/html" },
            body: `
                <html>
                    <body>
                        <h1>Secret Retrieved</h1>
                        <p>Secret Value: ${secretValue}</p>
                    </body>
                </html>
            `,
        };
    } catch (error) {
        return {
            status: 500,
            headers: { "Content-Type": "text/html" },
            body: `
                <html>
                    <body>
                        <h1>Error</h1>
                        <p>Could not retrieve the secret. Please try again later.</p>
                    </body>
                </html>
            `,
        };
    }
};

app.http('retrievepost', {
    methods: ['POST'],
    handler: postRetrieveForm
});
