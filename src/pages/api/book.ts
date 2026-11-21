
import type { APIRoute } from "astro";
import Stripe from "stripe";
import { supabase } from "../../lib/supabase";

export const prerender = false;

const stripeSecretKey = import.meta.env.STRIPE_SECRET_KEY;

if (!stripeSecretKey) {
    throw new Error("Missing STRIPE_SECRET_KEY");
}

const stripe = new Stripe(stripeSecretKey);

const APPOINTMENT_DURATION = 60;
const DEPOSIT_AMOUNT = 100; // £1 in pence

function getUKDate(): string {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());

    const get = (type: string) =>
        parts.find((part) => part.type === type)?.value ?? "";

    return `${get("year")}-${get("month")}-${get("day")}`;
}

function readString(value: unknown, maxLength: number): string | null {
    if (typeof value !== "string") return null;

    const result = value.trim();

    if (!result || result.length > maxLength) return null;

    return result;
}

async function cancelPendingAppointment(id: string) {
    const { error } = await supabase
        .from("appointments")
        .update({
            booking_status: "cancelled"
        })
        .eq("id", id)
        .eq("booking_status", "pending");

    if (error) {
        console.error("Failed to cancel pending appointment:", error);
    }
}

export const POST: APIRoute = async ({ request }) => {
    let body: Record<string, unknown>;

    try {
        body = await request.json();
    } catch {
        return Response.json(
            { error: "Invalid request body." },
            { status: 400 }
        );
    }

    // Extract and validate customer details
    const owner = readString(body.owner, 100);
    const phone = readString(body.phone, 30);
    const email = readString(body.email, 254);
    const dog = readString(body.dog, 100);
    const breed = readString(body.breed, 100);
    const size = readString(body.size, 20);

    const date = readString(body.date, 10);
    const time = readString(body.time, 5);

    if (
        !owner ||
        !phone ||
        !email ||
        !dog ||
        !breed ||
        !size ||
        !date ||
        !time
    ) {
        return Response.json(
            { error: "Please complete all booking fields." },
            { status: 400 }
        );
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return Response.json(
            { error: "Please enter a valid email address." },
            { status: 400 }
        );
    }

    if (phone.replace(/\D/g, "").length < 7) {
        return Response.json(
            { error: "Please enter a valid phone number." },
            { status: 400 }
        );
    }

    if (!["Small", "Medium", "Large"].includes(size)) {
        return Response.json(
            { error: "Invalid dog size." },
            { status: 400 }
        );
    }

    // Validate date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return Response.json(
            { error: "Invalid appointment date." },
            { status: 400 }
        );
    }

    const parsedDate = new Date(`${date}T00:00:00Z`);

    if (
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !== date ||
        date < getUKDate()
    ) {
        return Response.json(
            { error: "Please select a valid future date." },
            { status: 400 }
        );
    }

    // Validate opening hours and appointment time
    if (!/^(?:[01]\d|2[0-3]):00$/.test(time)) {
        return Response.json(
            { error: "Invalid appointment time." },
            { status: 400 }
        );
    }

    const day = parsedDate.getUTCDay();
    const hour = Number(time.split(":")[0]);

    const validWeekday =
        day >= 1 && day <= 4 && hour >= 16 && hour < 20;

    const validSaturday =
        day === 6 && hour >= 9 && hour < 18;

    if (!validWeekday && !validSaturday) {
        return Response.json(
            { error: "That appointment time is outside opening hours." },
            { status: 400 }
        );
    }

    // Validate website URL before creating the appointment
    const siteUrl = import.meta.env.SITE_URL;

    if (!siteUrl) {
        console.error("Missing SITE_URL environment variable");

        return Response.json(
            { error: "Website configuration error. Please try again later." },
            { status: 500 }
        );
    }

    let parsedSiteUrl: URL;

    try {
        parsedSiteUrl = new URL(siteUrl);

        if (
            !["http:", "https:"].includes(parsedSiteUrl.protocol) ||
            parsedSiteUrl.username ||
            parsedSiteUrl.password
        ) {
            throw new Error("Invalid SITE_URL");
        }
    } catch {
        return Response.json(
            { error: "Invalid website URL configuration." },
            { status: 500 }
        );
    }

    const baseUrl = parsedSiteUrl.origin;

    // Create pending appointment in Supabase
    const { data: appointment, error: insertError } = await supabase
        .from("appointments")
        .insert({
            owner_name: owner,
            owner_email: email,
            owner_phone: phone,
            dog_name: dog,
            dog_breed: breed,
            dog_size: size,
            appointment_date: date,
            appointment_time: `${time}:00`,
            duration_minutes: APPOINTMENT_DURATION,
            deposit_amount: DEPOSIT_AMOUNT,
            payment_status: "pending",
            booking_status: "pending"
        })
        .select("id")
        .single();

    if (insertError || !appointment) {
        console.error("Appointment creation failed:", insertError);

        if (insertError?.code === "23P01") {
            return Response.json(
                {
                    error: "Sorry, this appointment slot has just been taken. Please choose another time."
                },
                { status: 409 }
            );
        }

        return Response.json(
            { error: "Unable to create your booking. Please try again." },
            { status: 500 }
        );
    }

    let session: Stripe.Checkout.Session | null = null;

    try {
        // Create Stripe Checkout Session
        session = await stripe.checkout.sessions.create({
            mode: "payment",

            customer_email: email,

            client_reference_id: appointment.id,

            metadata: {
                appointment_id: appointment.id
            },

            line_items: [
                {
                    price_data: {
                        currency: "gbp",
                        product_data: {
                            name: "Dog Grooming Booking Deposit",
                            description: `Deposit for ${dog} - ${date} at ${time}`
                        },
                        unit_amount: DEPOSIT_AMOUNT
                    },
                    quantity: 1
                }
            ],

            success_url:
                `${baseUrl}/booking?payment=success&session_id={CHECKOUT_SESSION_ID}`,

            cancel_url:
                `${baseUrl}/booking?payment=cancelled`,

            // Release unpaid reservations after 30 minutes
            expires_at: Math.floor(Date.now() / 1000) + 1800
        });

        if (!session.url) {
            throw new Error("Stripe did not return a checkout URL.");
        }

        // Associate Stripe session with Supabase appointment
        const { data: updated, error: updateError } = await supabase
            .from("appointments")
            .update({
                stripe_session_id: session.id
            })
            .eq("id", appointment.id)
            .eq("booking_status", "pending")
            .select("id")
            .single();

        if (updateError || !updated) {
            throw new Error(
                updateError?.message || "Unable to link Stripe session."
            );
        }

        // Send checkout URL to frontend
        return Response.json({
            success: true,
            checkoutUrl: session.url
        });

    } catch (error) {
        console.error("Booking/payment creation failed:", error);

        // Expire an unused Stripe session if possible
        if (session?.status === "open") {
            try {
                await stripe.checkout.sessions.expire(session.id);
            } catch (expireError) {
                console.error(
                    "Unable to expire Stripe session:",
                    expireError
                );
            }
        }

        // Release the pending appointment
        await cancelPendingAppointment(appointment.id);

        return Response.json(
            { error: "Unable to start payment. Please try again." },
            { status: 502 }
        );
    }
};
