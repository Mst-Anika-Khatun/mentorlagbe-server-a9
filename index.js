
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

// Collections
const users = db.collection("users");
const tuitions = db.collection("tuitions");
const applications = db.collection("applications");
const payments = db.collection("payments");

// Database indexes
await applications.createIndex(
  { tuitionId: 1, email: 1 },
  { unique: true }
);

await payments.createIndex(
  { sessionId: 1 },
  { unique: true }
);

// Authentication
const jwks = createRemoteJWKSet(
  new URL(url + "/api/auth/jwks")
);

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const id = (value) => new ObjectId(value);

const fail = (res, message, status = 400) => {
  return res.status(status).json({ error: message });
};

function validId(value) {
  return typeof value === "string" &&
    /^[a-fA-F0-9]{24}$/.test(value);
}

// Verify logged-in user
async function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return fail(res, "Sign in required", 401);
    }

    const { payload } = await jwtVerify(token, jwks, {
      issuer: url,
      audience: url
    });

    if (!payload.email) {
      return fail(res, "Missing email", 401);
    }

    req.email = String(payload.email);
    req.account = await users.findOne({
      email: req.email
    });

    next();
  } catch (error) {
    return fail(res, "Sign in required", 401);
  }
}

// Role authorization
const role = (...roles) => (req, res, next) => {
  if (roles.includes(req.account?.role)) {
    return next();
  }

  return fail(res, "Forbidden", 403);
};

// Server health
app.get("/", (req, res) => {
  res.json({ name: "MentorLagbe API" });
});

// Create or update profile
app.post("/profile", auth, async (req, res) => {
  const selectedRole = String(
    req.body.role || ""
  ).trim().toLowerCase();

  const adminEmail = String(
    process.env.ADMIN_EMAIL || ""
  ).trim().toLowerCase();

  const currentRole = req.account?.role;

  let userRole = currentRole || "Student";

  if (
    adminEmail &&
    req.email.toLowerCase() === adminEmail
  ) {
    userRole = "Admin";
  } else if (
    process.env.NODE_ENV !== "production" &&
    ["student", "tutor"].includes(selectedRole)
  ) {
    // Local testing only
    userRole = selectedRole === "tutor"
      ? "Tutor"
      : "Student";
  } else if (!currentRole) {
    userRole = selectedRole === "tutor"
      ? "Tutor"
      : "Student";
  }

  const fields = {
    role: userRole
  };

  if (req.body.name !== undefined) {
    fields.name = String(req.body.name);
  }

  if (req.body.photo !== undefined) {
    fields.photo = String(req.body.photo);
  }

  await users.updateOne(
    { email: req.email },
    {
      $setOnInsert: {
        email: req.email,
        plan: "free"
      },
      $set: fields
    },
    { upsert: true }
  );

  res.json(await users.findOne({
    email: req.email
  }));
});

// Get profile
app.get("/profile", auth, async (req, res) => {
  res.json(req.account);
});

// Get approved tuitions
app.get("/tuitions", async (req, res) => {
  const result = await tuitions.find({
    status: "approved",
    active: true
  }).sort({ _id: -1 }).toArray();

  res.json(result);
});

// Get single tuition
app.get("/tuitions/:id", async (req, res) => {
  if (!validId(req.params.id)) {
    return fail(res, "Invalid tuition ID");
  }

  const tuition = await tuitions.findOne({
    _id: id(req.params.id),
    status: "approved",
    active: true
  });

  if (!tuition) {
    return fail(res, "Not found", 404);
  }

  res.json(tuition);
});

// Create tuition
app.post(
  "/tuitions",
  auth,
  role("Tutor"),
  async (req, res) => {
    if (
      req.account.plan !== "pro" &&
      await tuitions.countDocuments({
        email: req.email
      }) >= 2
    ) {
      return fail(res, "Upgrade to Pro");
    }

    const {
      title,
      subject,
      location,
      salary,
      description
    } = req.body;

    if (
      !title ||
      !subject ||
      !location ||
      !Number.isFinite(Number(salary)) ||
      Number(salary) <= 0
    ) {
      return fail(res, "Complete all fields");
    }

    const result = await tuitions.insertOne({
      title,
      subject,
      location,
      salary: Number(salary),
      description,
      email: req.email,
      status: "pending",
      active: true,
      createdAt: new Date()
    });

    res.json(result);
  }
);

// Tutor's own tuitions
app.get(
  "/mine",
  auth,
  role("Tutor"),
  async (req, res) => {
    const result = await tuitions.find({
      email: req.email
    }).toArray();

    res.json(result);
  }
);

// Update tuition
app.patch(
  "/tuitions/:id",
  auth,
  role("Tutor"),
  async (req, res) => {
    if (!validId(req.params.id)) {
      return fail(res, "Invalid tuition ID");
    }

    const fields = {};

    for (const key of [
      "title",
      "subject",
      "location",
      "salary",
      "description",
      "active"
    ]) {
      if (key in req.body) {
        fields[key] = req.body[key];
      }
    }

    if ("salary" in fields) {
      fields.salary = Number(fields.salary);

      if (
        !Number.isFinite(fields.salary) ||
        fields.salary <= 0
      ) {
        return fail(res, "Invalid salary");
      }
    }

    if ("active" in fields) {
      if (typeof fields.active !== "boolean") {
        return fail(res, "Invalid active value");
      }
    }

    if (!Object.keys(fields).length) {
      return fail(res, "No fields to update");
    }

    const result = await tuitions.updateOne(
      {
        _id: id(req.params.id),
        email: req.email
      },
      {
        $set: {
          ...fields,
          status: "pending"
        }
      }
    );

    res.json(result);
  }
);

// Delete tuition
app.delete(
  "/tuitions/:id",
  auth,
  role("Tutor"),
  async (req, res) => {
    if (!validId(req.params.id)) {
      return fail(res, "Invalid tuition ID");
    }

    const result = await tuitions.deleteOne({
      _id: id(req.params.id),
      email: req.email
    });

    res.json(result);
  }
);

// Submit application
app.post(
  "/applications",
  auth,
  role("Student"),
  async (req, res) => {
    const {
      tuitionId,
      phone,
      schedule,
      note
    } = req.body;

    if (!validId(tuitionId)) {
      return fail(res, "Invalid tuition ID");
    }

    const tuition = await tuitions.findOne({
      _id: id(tuitionId),
      status: "approved",
      active: true
    });

    if (!tuition || !phone || !schedule) {
      return fail(res, "Invalid application");
    }

    try {
      const result = await applications.insertOne({
        tuitionId,
        email: req.email,
        tutor: tuition.email,
        title: tuition.title,
        phone,
        schedule,
        note,
        status: "pending",
        createdAt: new Date()
      });

      res.json(result);
    } catch (error) {
      if (error.code === 11000) {
        return fail(res, "Already applied");
      }

      throw error;
    }
  }
);

// Get applications
app.get(
  "/applications",
  auth,
  async (req, res) => {
    const filter =
      req.account?.role === "Tutor"
        ? { tutor: req.email }
        : { email: req.email };

    const result = await applications
      .find(filter)
      .sort({ _id: -1 })
      .toArray();

    res.json(result);
  }
);

// Accept or reject application
app.patch(
  "/applications/:id",
  auth,
  role("Tutor"),
  async (req, res) => {
    if (!validId(req.params.id)) {
      return fail(res, "Invalid application ID");
    }

    if (
      !["accepted", "rejected"].includes(
        req.body.status
      )
    ) {
      return fail(res, "Invalid status");
    }

    const result = await applications.updateOne(
      {
        _id: id(req.params.id),
        tutor: req.email,
        status: "pending"
      },
      {
        $set: {
          status: req.body.status
        }
      }
    );

    res.json(result);
  }
);

// Cancel application
app.delete(
  "/applications/:id",
  auth,
  role("Student"),
  async (req, res) => {
    if (!validId(req.params.id)) {
      return fail(res, "Invalid application ID");
    }

    const result = await applications.deleteOne({
      _id: id(req.params.id),
      email: req.email,
      status: "pending"
    });

    res.json(result);
  }
);

// Admin records
app.get(
  "/admin/:collection",
  auth,
  role("Admin"),
  async (req, res) => {
    const allowed = [
      "users",
      "tuitions",
      "payments"
    ];

    if (!allowed.includes(req.params.collection)) {
      return fail(res, "Invalid collection");
    }

    const result = await db
      .collection(req.params.collection)
      .find()
      .toArray();

    res.json(result);
  }
);

// Admin approve or reject tuition
app.patch(
  "/admin/tuitions/:id",
  auth,
  role("Admin"),
  async (req, res) => {
    if (!validId(req.params.id)) {
      return fail(res, "Invalid tuition ID");
    }

    if (
      !["approved", "rejected"].includes(
        req.body.status
      )
    ) {
      return fail(res, "Invalid status");
    }

    const result = await tuitions.updateOne(
      { _id: id(req.params.id) },
      {
        $set: {
          status: req.body.status
        }
      }
    );

    res.json(result);
  }
);

// Stripe checkout
app.post(
  "/checkout",
  auth,
  role("Student", "Tutor"),
  async (req, res) => {
    if (!stripe) {
      return fail(res, "Stripe not configured");
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: req.account.role + " Pro"
            },
            unit_amount:
              req.account.role === "Tutor"
                ? 1500
                : 1000
          },
          quantity: 1
        }
      ],
      metadata: {
        email: req.email
      },
      success_url:
        url +
        "/payment/success?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:
        url + "/payment/cancel"
    });

    res.json({ url: session.url });
  }
);

// Verify payment
app.post(
  "/payment/verify",
  auth,
  async (req, res) => {
    if (!stripe) {
      return fail(res, "Stripe not configured");
    }

    if (!req.body.sessionId) {
      return fail(res, "Missing session ID");
    }

    const session =
      await stripe.checkout.sessions.retrieve(
        req.body.sessionId
      );

    if (
      session.payment_status !== "paid" ||
      session.metadata?.email !== req.email
    ) {
      return fail(res, "Payment not verified");
    }

    await payments.updateOne(
      { sessionId: session.id },
      {
        $setOnInsert: {
          sessionId: session.id,
          email: req.email,
          amount: session.amount_total / 100,
          status: "paid",
          date: new Date()
        }
      },
      { upsert: true }
    );

    await users.updateOne(
      { email: req.email },
      {
        $set: {
          plan: "pro"
        }
      }
    );

    res.json({ success: true });
  }
);

// Payment history
app.get(
  "/payments",
  auth,
  async (req, res) => {
    const result = await payments.find({
      email: req.email
    }).sort({ date: -1 }).toArray();

    res.json(result);
  }
);

// Error handler
app.use((error, req, res, next) => {
  console.error(error);

  res.status(500).json({
    error: "Request failed"
  });
});

// Start server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    "MentorLagbe server running on port " + PORT
  );
});
