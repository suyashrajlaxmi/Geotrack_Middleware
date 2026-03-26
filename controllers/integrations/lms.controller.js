// controllers/integrations/lms.controller.js - FIXED
import bcrypt from "bcryptjs";
import { pool } from "../../db.js";
import crypto from "crypto";
import { extractDomain, isGenericEmailDomain } from "../../services/emailDomain.service.js";

export const handleLicensePurchase = async (req, res) => {
  console.log("\n🎯 LMS License Purchase Webhook Received");
  console.log("=".repeat(60));

  const client = await pool.connect();

  try {
    const {
      purchaseId,
      licenseKey,
      email,
      password,
      fullName,
      companyName,
      subdomain,
      planType,
      maxUsers,
      expiryDate,
      isRenewal = false
    } = req.body;

    console.log("📦 Payload received:");
    console.log(`   Purchase ID: ${purchaseId}`);
    console.log(`   Email: ${email}`);
    console.log(`   Company: ${companyName}`);
    console.log(`   Subdomain: ${subdomain}`);
    console.log(`   License Key: ${licenseKey}`);
    console.log(`   Plan: ${planType}`);
    console.log(`   Max Users: ${maxUsers}`);
    console.log(`   Expiry: ${expiryDate}`);
    console.log(`   Is Renewal: ${isRenewal}`);
    console.log(`   Password provided: ${password ? 'Yes' : 'No'}`);

    // Validate required fields
    if (!email || !companyName || !subdomain || !licenseKey) {
      console.error("❌ Missing required fields");
      return res.status(400).json({
        error: "ValidationError",
        message: "Missing required fields: email, companyName, subdomain, licenseKey"
      });
    }

    // ✅ Normalize and validate plan
    const normalizedPlan = (planType || "starter").toLowerCase();
    const validPlans = ['starter', 'professional', 'business', 'enterprise'];
    
    if (!validPlans.includes(normalizedPlan)) {
      console.error(`❌ Invalid plan type: ${planType}`);
      return res.status(400).json({
        error: "ValidationError",
        message: `Invalid plan type: ${planType}. Must be one of: ${validPlans.join(', ')}`
      });
    }
    
    console.log(`   Plan (normalized): ${normalizedPlan}`);

    // ✅ Extract email domain from admin email
    let emailDomain = null;
    try {
      const extractedDomain = extractDomain(email);
      // Only set if not a generic domain (gmail, yahoo, etc.)
      if (!isGenericEmailDomain(email)) {
        emailDomain = extractedDomain;
        console.log(`   📧 Email domain extracted: ${emailDomain}`);
      } else {
        console.log(`   ⚠️ Generic email detected (${extractedDomain}), not setting email_domain`);
      }
    } catch (error) {
      console.log(`   ⚠️ Could not extract email domain: ${error.message}`);
    }

    await client.query("BEGIN");

    // Check if company already exists
    const existingCompany = await client.query(
      `SELECT id, name, subdomain, email_domain FROM companies WHERE subdomain = $1`,
      [subdomain.toLowerCase()]
    );

    let company;
    let isNewCompany = false;

    if (existingCompany.rows.length > 0) {
      // RENEWAL/UPGRADE PATH
      company = existingCompany.rows[0];
      console.log(`\n🔄 Existing company found: ${company.name} (${company.id})`);
      
      // ✅ Update email_domain if not already set
      if (!company.email_domain && emailDomain) {
        await client.query(
          `UPDATE companies
           SET email_domain = $1, is_active = true, updated_at = NOW()
           WHERE id = $2`,
          [emailDomain, company.id]
        );
        console.log(`   📧 Email domain set: ${emailDomain}`);
      } else {
        await client.query(
          `UPDATE companies
           SET is_active = true, updated_at = NOW()
           WHERE id = $1`,
          [company.id]
        );
      }
      console.log(`✅ Company settings updated`);

    } else {
      // NEW PURCHASE PATH
      isNewCompany = true;
      console.log(`\n✨ Creating new company: ${companyName}`);
      
      // ✅ Include email_domain in INSERT
      const companyResult = await client.query(
        `INSERT INTO companies (name, subdomain, email_domain, is_active)
         VALUES ($1, $2, $3, true)
         RETURNING id, name, subdomain, email_domain`,
        [companyName, subdomain.toLowerCase(), emailDomain]
      );

      company = companyResult.rows[0];
      console.log(`✅ Company created: ${company.name} (@${company.subdomain})`);
      if (company.email_domain) {
        console.log(`   📧 Email domain set: ${company.email_domain}`);
      }
    }

    // Upsert license
    console.log("\n🎫 Upserting license record...");

    const licenseResult = await client.query(
      `INSERT INTO company_licenses (company_id, license_key, plan, max_users, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id) 
       DO UPDATE SET 
         license_key = EXCLUDED.license_key,
         plan = EXCLUDED.plan,
         max_users = EXCLUDED.max_users,
         expires_at = EXCLUDED.expires_at,
         created_at = NOW()
       RETURNING id, license_key, 
         (xmax = 0) AS inserted`,
      [
        company.id,
        licenseKey,
        normalizedPlan, // ✅ Use normalized lowercase plan
        maxUsers || 1,
        expiryDate ? new Date(expiryDate) : null
      ]
    );

    const licenseOp = licenseResult.rows[0].inserted ? "created" : "updated";
    console.log(`✅ License ${licenseOp}: ${licenseKey}`);

    // Handle user account
    const existingUser = await client.query(
      `SELECT id, email, company_id FROM users WHERE email = $1`,
      [email]
    );

    let user;
    let userPassword = password;

    if (existingUser.rows.length > 0) {
      // USER ALREADY EXISTS
      user = existingUser.rows[0];
      console.log(`\n👤 Existing user found: ${user.email}`);
      
      if (user.company_id !== company.id) {
        await client.query(
          `UPDATE users SET company_id = $1 WHERE id = $2`,
          [company.id, user.id]
        );
        console.log(`✅ User reassigned to company: ${company.name}`);
      }
      
      if (password && password.trim() !== '') {
        const hashedPassword = await bcrypt.hash(password, 10);
        await client.query(
          `UPDATE users SET password = $1 WHERE id = $2`,
          [hashedPassword, user.id]
        );
        console.log(`✅ User password updated`);
      }

    } else {
      // CREATE NEW USER
      console.log(`\n👤 Creating new user account...`);

      if (!userPassword || userPassword.trim() === '') {
        userPassword = crypto.randomBytes(12).toString('base64').slice(0, 16);
        console.log(`🔐 Generated password for user`);
      }

      const hashedPassword = await bcrypt.hash(userPassword, 10);
      
      const userResult = await client.query(
        `INSERT INTO users (email, password, is_admin, company_id)
         VALUES ($1, $2, true, $3)
         RETURNING id, email`,
        [email, hashedPassword, company.id]
      );

      user = userResult.rows[0];
      console.log(`✅ User created: ${user.email} (Admin)`);

      await client.query(
        `INSERT INTO profiles (user_id, full_name)
         VALUES ($1, $2)`,
        [user.id, fullName || email.split('@')[0]]
      );
      console.log(`✅ Profile created`);
    }

    await client.query("COMMIT");

    console.log("\n✅ License provisioning completed successfully!");
    console.log("=".repeat(60));

    return res.status(201).json({
      success: true,
      message: isNewCompany ? "Company and user created successfully" : "License renewed/upgraded successfully",
      isNewPurchase: isNewCompany,
      company: {
        id: company.id,
        name: company.name,
        subdomain: company.subdomain,
        emailDomain: company.email_domain,
        url: `https://${company.subdomain}.yourdomain.com`
      },
      user: {
        id: user.id,
        email: user.email,
        isAdmin: true,
        temporaryPassword: isNewCompany ? userPassword : undefined
      },
      license: {
        key: licenseKey,
        plan: normalizedPlan, // ✅ Return normalized plan
        maxUsers: maxUsers,
        expiryDate: expiryDate,
        operation: licenseOp
      }
    });

  } catch (error) {
    await client.query("ROLLBACK");
    
    console.error("\n❌ License provisioning failed!");
    console.error("=".repeat(60));
    console.error("Error:", error.message);
    console.error("Stack:", error.stack);

    if (error.code === '23505' && error.constraint?.includes('license_key')) {
      return res.status(409).json({
        error: "LicenseKeyExists",
        message: `License key "${req.body.licenseKey}" is already in use`
      });
    }

    if (error.code === '23505' && error.constraint?.includes('email_domain')) {
      return res.status(409).json({
        error: "EmailDomainExists",
        message: `Email domain is already registered to another company`
      });
    }

    return res.status(500).json({
      error: "ProvisioningFailed",
      message: error.message
    });

  } finally {
    client.release();
  }
}