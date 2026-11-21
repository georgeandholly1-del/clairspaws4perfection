
import type { APIRoute } from "astro";
import Stripe from "stripe";
import { supabase } from "../../lib/supabase";

export const prerender = false;

const stripeSecretKey = import.meta.env.STRIPE_SECRET_KEY;
const webhookSecret = import.meta.env.STRIPE_WEBHOOK_SECRET;

if (!stripeSecretKey) {
    throw new Error("Missing STRIPE_SECRET_KEY");
}

const stripe = new Stripe(stripeSecretKey);

export const POST: APIRoute = async ({ request }) => {
    if (!webhookSecret) {
        return Response.json(
            { error: "Webhook secret is not configured." },
            { status: 500 }
        );
    }

    const signature = request.headers.get("stripe-signature");

    if (!signature) {
        return Response.json(
            { error: "Missing Stripe signature." },
            { status: 400 }
        );
    }

    // Stripe requires the unmodified raw request body
    const body = await request.text();

    let event: Stripe.Event;

    try {
        event = stripe.webhooks.constructEvent(
            body,
            signature,
            webhookSecret
        );
    } catch (error) {
        console.error("Webhook signature verification failed:", error);

        return Response.json(
            { error: "Invalid webhook signature." },
            { status: 400 }
        );
    }

    try {
        switch (event.type) {
            case "checkout.session.completed":
            case "checkout.session.async_payment_succeeded": {
                const session = event.data.object as Stripe.Checkout.Session;

                // Only confirm bookings after successful payment
                if (session.payment_status !== "paid") {
                    break;
                }

                const { data, error } = await supabase
                    .from("appointments")
                    .update({
                        payment_status: "paid",
                        booking_status: "confirmed"
                    })
                    .eq("stripe_session_id", session.id)
                    .select("id")
                    .maybeSingle();

                if (error) {
                    console.error("Booking confirmation failed:", error);
                    return Response.json(
                        { error: "Database update failed." },
                        { status: 500 }
                    );
                }

                if (!data) {
                    console.error(
                        "No appointment found for Stripe session:",
                        session.id
                    );

                    return Response.json(
                        { error: "Appointment not found." },
                        { status: 500 }
                    );
                }

                console.log("Booking confirmed:", data.id);
                break;
            }

            case "checkout.session.expired":
            case "checkout.session.async_payment_failed": {
                const session = event.data.object as Stripe.Checkout.Session;

                const { error } = await supabase
                    .from("appointments")
                    .update({
                        booking_status: "cancelled"
                    })
                    .eq("stripe_session_id", session.id)
                    .eq("booking_status", "pending");

                if (error) {
                    console.error("Booking cancellation failed:", error);

                    return Response.json(
                        { error: "Database update failed." },
                        { status: 500 }
                    );
                }

                console.log("Booking expired or payment failed:", session.id);
                break;
            }

            default:
                console.log("Unhandled Stripe event:", event.type);
        }

        return Response.json({ received: true });

    } catch (error) {
        console.error("Webhook processing error:", error);

        return Response.json(
            { error: "Webhook processing failed." },
            { status: 500 }
        );
    }
};
