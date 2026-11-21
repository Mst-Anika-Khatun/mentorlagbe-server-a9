
import dns from "node:dns";
import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";
import Stripe from "stripe";

dns.setServers(["8.8.8.8", "8.8.4.4"]);

const app = express();
const url = process.env.CLIENT_URL || "http://localhost:3000";

app.use(cors({ origin: url }));
app.use(express.json());

// MongoDB connection
const mongo = await MongoClient.connect(process.env.MONGODB_URI);
const db = mongo.db("mentorlagbe");

// Database collections
const users = db.collection("users");
const tuitions = db.collection("tuitions");
const applications = db.collection("applications");
const payments = db.collection("payments");

// Create unique indexes
await applications.createIndex(
    { tuitionId: 1, email: 1 },
    { unique: true }
);

await payments.createIndex(
    { sessionId: 1 },
    { unique: true }
);

// Authentication and Stripe configuration
const jwks = createRemoteJWKSet(
    new URL(url + "/api/auth/jwks")
);

const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY)
    : null;

const id = x => new ObjectId(x);

const fail = (r, m, s = 400) => {
    return r.status(s).json({ error: m });
};

// Verify authenticated user
async function auth(req, res, next) {
    try {
        const token = req.headers.authorization?.split(" ")[1];

        const { payload } = await jwtVerify(token, jwks, {
            issuer: url,
            audience: url
        });

        const email = payload.email;

        if (!email) {
            return fail(res, "Missing email", 401);
        }

        req.email = email;
        req.account = await users.findOne({ email });

        next();
    } catch {
        return fail(res, "Sign in required", 401);
    }
}

// Verify user role
const role = (...roles) => (q, r, n) => {
    return roles.includes(q.account?.role)
        ? n()
        : fail(r, "Forbidden", 403);
};

// Server health check
app.get("/", (q, r) => {
    r.json({ name: "MentorLagbe API" });
});

// Create or update user profile
app.post("/profile", auth, async (q, r) => {
    const selectedRole = String(
        q.body.role || ""
    ).trim().toLowerCase();

    const adminEmail = String(
        process.env.ADMIN_EMAIL || ""
    ).trim().toLowerCase();

    let userRole;

    if (adminEmail && q.email.toLowerCase() === adminEmail) {
        userRole = "Admin";
    } else if (q.account?.role === "Tutor") {
        userRole = "Tutor";
    } else if (q.account?.role === "Student") {
        userRole = "Student";
    } else {
        userRole = selectedRole === "tutor"
            ? "Tutor"
            : "Student";
    }

    await users.updateOne(
        { email: q.email },
        {
            $setOnInsert: {
                email: q.email,
                plan: "free"
            },
            $set: {
                role: userRole,
                name: String(q.body.name || ""),
                photo: String(q.body.photo || "")
            }
        },
        { upsert: true }
    );

    r.json(await users.findOne({ email: q.email }));
});

// Get user profile
app.get("/profile", auth, (q, r) => {
    r.json(q.account);
});

// Get approved tuitions
app.get("/tuitions", async (q, r) => {
    const result = await tuitions.find({
        status: "approved",
        active: true
    }).sort({ _id: -1 }).toArray();

    r.json(result);
});

// Get tuition details
app.get("/tuitions/:id", async (q, r) => {
    const tuition = await tuitions.findOne({
        _id: id(q.params.id),
        status: "approved",
        active: true
    });

    tuition
        ? r.json(tuition)
        : fail(r, "Not found", 404);
});

// Create tuition
app.post("/tuitions", auth, role("Tutor"), async (q, r) => {
    if (
        q.account.plan !== "pro" &&
        await tuitions.countDocuments({ email: q.email }) >= 2
    ) {
        return fail(r, "Upgrade to Pro");
    }

    const {
        title,
        subject,
        location,
        salary,
        description
    } = q.body;

    if (!title || !subject || !location || !salary) {
        return fail(r, "Complete all fields");
    }

    const result = await tuitions.insertOne({
        title,
        subject,
        location,
        salary: Number(salary),
        description,
        email: q.email,
        status: "pending",
        active: true,
        createdAt: new Date()
    });

    r.json(result);
});

// Get tutor's own tuitions
app.get("/mine", auth, role("Tutor"), async (q, r) => {
    const result = await tuitions.find({
        email: q.email
    }).toArray();

    r.json(result);
});

// Update tuition
app.patch("/tuitions/:id", auth, role("Tutor"), async (q, r) => {
    const fields = {};

    for (const k of [
        "title",
        "subject",
        "location",
        "salary",
        "description",
        "active"
    ]) {
        if (k in q.body) {
            fields[k] = q.body[k];
        }
    }

    const result = await tuitions.updateOne(
        {
            _id: id(q.params.id),
            email: q.email
        },
        {
            $set: {
                ...fields,
                status: "pending"
            }
        }
    );

    r.json(result);
});

// Delete tuition
app.delete("/tuitions/:id", auth, role("Tutor"), async (q, r) => {
    const result = await tuitions.deleteOne({
        _id: id(q.params.id),
        email: q.email
    });

    r.json(result);
});

// Submit tuition application
app.post("/applications", auth, role("Student"), async (q, r) => {
    const { tuitionId, phone, schedule, note } = q.body;

    const tuition = await tuitions.findOne({
        _id: id(tuitionId),
        status: "approved",
        active: true
    });

    if (!tuition || !phone || !schedule) {
        return fail(r, "Invalid application");
    }

    try {
        const result = await applications.insertOne({
            tuitionId,
            email: q.email,
            tutor: tuition.email,
            title: tuition.title,
            phone,
            schedule,
            note,
            status: "pending"
        });

        r.json(result);
    } catch (e) {
        if (e.code === 11000) {
            return fail(r, "Already applied");
        }

        throw e;
    }
});

// Get user applications
app.get("/applications", auth, async (q, r) => {
    const filter = q.account?.role === "Tutor"
        ? { tutor: q.email }
        : { email: q.email };

    r.json(await applications.find(filter).toArray());
});

// Accept or reject application
app.patch("/applications/:id", auth, role("Tutor"), async (q, r) => {
    if (!["accepted", "rejected"].includes(q.body.status)) {
        return fail(r, "Invalid status");
    }

    const result = await applications.updateOne(
        {
            _id: id(q.params.id),
            tutor: q.email,
            status: "pending"
        },
        {
            $set: { status: q.body.status }
        }
    );

    r.json(result);
});

// Cancel application
app.delete("/applications/:id", auth, role("Student"), async (q, r) => {
    const result = await applications.deleteOne({
        _id: id(q.params.id),
        email: q.email,
        status: "pending"
    });

    r.json(result);
});

// Admin dashboard records
app.get("/admin/:collection", auth, role("Admin"), async (q, r) => {
    if (!["users", "tuitions", "payments"].includes(q.params.collection)) {
        return fail(r, "Invalid collection");
    }

    const result = await db.collection(
        q.params.collection
    ).find().toArray();

    r.json(result);
});

// Admin tuition approval
app.patch("/admin/tuitions/:id", auth, role("Admin"), async (q, r) => {
    if (!["approved", "rejected"].includes(q.body.status)) {
        return fail(r, "Invalid status");
    }

    const result = await tuitions.updateOne(
        { _id: id(q.params.id) },
        { $set: { status: q.body.status } }
    );

    r.json(result);
});

// Create Stripe checkout
app.post("/checkout", auth, role("Student", "Tutor"), async (q, r) => {
    if (!stripe) {
        return fail(r, "Stripe not configured");
    }

    const session = await stripe.checkout.sessions.create({
        mode: "payment",

        line_items: [
            {
                price_data: {
                    currency: "usd",
                    product_data: {
                        name: q.account.role + " Pro"
                    },
                    unit_amount: q.account.role === "Tutor"
                        ? 1500
                        : 1000
                },
                quantity: 1
            }
        ],

        metadata: {
            email: q.email
        },

        success_url:
            url + "/payment/success?session_id={CHECKOUT_SESSION_ID}",

        cancel_url:
            url + "/payment/cancel"
    });

    r.json({ url: session.url });
});

// Verify Stripe payment
app.post("/payment/verify", auth, async (q, r) => {
    if (!stripe) {
        return fail(r, "Stripe not configured");
    }

    const session = await stripe.checkout.sessions.retrieve(
        q.body.sessionId
    );

    if (
        session.payment_status !== "paid" ||
        session.metadata?.email !== q.email
    ) {
        return fail(r, "Payment not verified");
    }

    await payments.updateOne(
        { sessionId: session.id },
        {
            $setOnInsert: {
                sessionId: session.id,
                email: q.email,
                amount: session.amount_total / 100,
                status: "paid",
                date: new Date()
            }
        },
        { upsert: true }
    );

    await users.updateOne(
        { email: q.email },
        { $set: { plan: "pro" } }
    );

    r.json({ success: true });
});

// Get payment history
app.get("/payments", auth, async (q, r) => {
    const result = await payments.find({
        email: q.email
    }).sort({ date: -1 }).toArray();

    r.json(result);
});

// Error handling
app.use((e, q, r, n) => {
    console.error(e);

    r.status(500).json({
        error: "Request failed"
    });
});

// Start server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log("MentorLagbe server running on port " + PORT);
});
