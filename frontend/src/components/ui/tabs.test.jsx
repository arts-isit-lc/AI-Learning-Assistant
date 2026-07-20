import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs"

describe("Tabs", () => {
  it("shows the active tab's panel and marks it selected", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">Config</TabsTrigger>
          <TabsTrigger value="b">Insights</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Config panel</TabsContent>
        <TabsContent value="b">Insights panel</TabsContent>
      </Tabs>
    )
    expect(screen.getByRole("tab", { name: "Config" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByText("Config panel")).toBeInTheDocument()
    expect(screen.queryByText("Insights panel")).not.toBeInTheDocument()
  })
})
