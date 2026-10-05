import { createHash, timingSafeEqual } from "node:crypto";
import { Body, Controller, Headers, HttpCode, HttpException, Inject, Post } from "@nestjs/common";
import { Public as InternalBillingServiceAuth } from "@alterx/auth";
import { TenantIdSchema } from "@alterx/contracts";
import { z } from "zod";
import { BillingAccountPolicySchema, BillingAdmissionError, EngineBillingAccountService } from "./billing-account.service";
export const BILLING_SYNC_TOKEN_HASH=Symbol("BILLING_SYNC_TOKEN_HASH");
const grantSchema=z.object({tenantId:TenantIdSchema,eventRef:z.string().min(1).max(255),credits:z.number().int().positive().max(1000000000)}).strict();
@InternalBillingServiceAuth()
@Controller("internal/billing")
export class BillingAccountController {
  constructor(@Inject(EngineBillingAccountService) private readonly billing: EngineBillingAccountService,@Inject(BILLING_SYNC_TOKEN_HASH) private readonly hash:string) {}
  @Post("policy") @HttpCode(200)
  async policy(@Body() input:unknown,@Headers("authorization") authorization?:string){
    this.authenticate(authorization);const parsed=BillingAccountPolicySchema.safeParse(input);if(!parsed.success)throw new HttpException("Invalid billing policy",400);
    try{await this.billing.syncPolicy(parsed.data);return {revision:parsed.data.revision};}catch(error){throw this.map(error);}
  }
  @Post("grant") @HttpCode(200)
  async grant(@Body() input:unknown,@Headers("authorization") authorization?:string){
    this.authenticate(authorization);const parsed=grantSchema.safeParse(input);if(!parsed.success)throw new HttpException("Invalid credit grant",400);
    try{return {applied:await this.billing.grant(parsed.data.tenantId,parsed.data.eventRef,parsed.data.credits)};}catch(error){throw this.map(error);}
  }
  @Post("account") @HttpCode(200)
  async account(@Body() input:unknown,@Headers("authorization") authorization?:string){
    this.authenticate(authorization);const parsed=z.object({tenantId:TenantIdSchema}).strict().safeParse(input);if(!parsed.success)throw new HttpException("Invalid account lookup",400);
    try{return await this.billing.readAccount(parsed.data.tenantId);}catch(error){throw this.map(error);}
  }
  private authenticate(authorization?:string):void{
    const token=authorization?.startsWith("Bearer ")?authorization.slice(7):"",actual=createHash("sha256").update(token).digest(),expected=Buffer.from(this.hash,"hex");
    if(!token||expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new HttpException("Internal billing service authentication required",401);
  }
  private map(error:unknown):unknown{return error instanceof BillingAdmissionError?new HttpException({error_code:error.code},409):error;}
}
