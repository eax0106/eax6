import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { TenantActivityWindowSchema } from "@alterx/contracts";
import { TenantSpendService } from "./tenant-spend.service";

/** Existing global ServiceAuthGuard authenticates this service-only endpoint. */
@Controller("internal/tenant-spend")
export class TenantSpendController {
  constructor(private readonly spend: TenantSpendService) {}
  @Get()
  read(@Query() query: unknown) {
    const input = TenantActivityWindowSchema.safeParse(query);
    if (!input.success) throw new BadRequestException("Invalid tenant spend window");
    return this.spend.spend(input.data);
  }
}
