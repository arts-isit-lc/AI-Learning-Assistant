import { useState } from "react"
import { MdHome, MdWarning, MdInfo, MdMoreVert, MdInbox } from "react-icons/md"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip"
import { Icon } from "@/components/ui/icon"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogClose,
} from "@/components/ui/dialog"
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Toggle } from "@/components/ui/toggle"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command"
// Composed (Phase 4b)
import { PageHeader } from "@/components/composed/PageHeader"
import { BackButton } from "@/components/composed/BackButton"
import { Breadcrumb } from "@/components/composed/Breadcrumb"
import { EmptyState } from "@/components/composed/EmptyState"
import { Tag } from "@/components/composed/Tag"
import { StatCard } from "@/components/composed/StatCard"
import { FileRow } from "@/components/composed/FileRow"
import { ListRow } from "@/components/composed/ListRow"
import { CourseCard } from "@/components/composed/CourseCard"
import { StudentRow } from "@/components/composed/StudentRow"
import { ProfileHeader } from "@/components/composed/ProfileHeader"
import { DataTable } from "@/components/composed/DataTable"
import { FormField } from "@/components/composed/FormField"
import { Searchbar } from "@/components/composed/Searchbar"
import { LanguageModelDropdown } from "@/components/composed/LanguageModelDropdown"
import { ConfirmDialog } from "@/components/composed/ConfirmDialog"

function Section({ id, title, children }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4">
      <h2 id={id} className="text-h4 text-navy border-b border-border pb-2">
        {title}
      </h2>
      <div className="flex flex-wrap items-start gap-4">{children}</div>
    </section>
  )
}

const BUTTON_VARIANTS = ["default", "secondary", "outline", "ghost", "danger", "cta", "link"]
const BADGE_VARIANTS = ["default", "secondary", "success", "warning", "info", "destructive", "outline"]
const ALERT_VARIANTS = ["default", "info", "success", "warning", "destructive"]

/**
 * OCELIA component gallery (Phase 4, dev-only) at /gallery. Renders every
 * primitive in its key states so the library can be eyeballed + regression
 * checked. Composed components are appended as they're built.
 */
const COURSE = { course_department: "geog", course_number: "250", course_name: "Introduction to Geography" }
const TABLE_COLUMNS = [
  { accessorKey: "module", header: "Module" },
  { accessorKey: "concept", header: "Concept" },
]
const TABLE_DATA = [
  { module: "Week 1", concept: "Maps" },
  { module: "Week 2", concept: "Climate" },
]

export default function Gallery() {
  const [confirmOpen, setConfirmOpen] = useState(false)
  return (
    <TooltipProvider>
      <main className="min-h-screen bg-background px-8 py-10 text-left text-foreground">
        <div className="mx-auto flex max-w-5xl flex-col gap-12">
          <header className="flex flex-col gap-2">
            <h1 className="text-h2 font-semibold text-navy">OCELIA component gallery</h1>
            <p className="text-body text-muted-foreground">
              Phase 4 primitives, each shown in its states. Tokens preview lives at{" "}
              <code className="text-caption">/style-guide</code>.
            </p>
          </header>

          <Section id="g-button" title="Button — variants, sizes, states">
            {BUTTON_VARIANTS.map((v) => (
              <Button key={v} variant={v}>
                {v}
              </Button>
            ))}
            <Button size="sm">sm</Button>
            <Button size="lg">lg</Button>
            <Button size="icon" aria-label="Home">
              <Icon icon={MdHome} />
            </Button>
            <Button disabled>disabled</Button>
            <Button loading>loading</Button>
          </Section>

          <Section id="g-badge" title="Badge">
            {BADGE_VARIANTS.map((v) => (
              <Badge key={v} variant={v}>
                {v}
              </Badge>
            ))}
          </Section>

          <Section id="g-alert" title="Alert">
            <div className="flex w-full flex-col gap-3">
              {ALERT_VARIANTS.map((v) => (
                <Alert key={v} variant={v}>
                  <Icon icon={v === "warning" ? MdWarning : MdInfo} size={18} />
                  <AlertTitle>{v}</AlertTitle>
                  <AlertDescription>A {v} message shown inline.</AlertDescription>
                </Alert>
              ))}
            </div>
          </Section>

          <Section id="g-inputs" title="Input / Textarea / Label">
            <div className="flex w-full flex-col gap-3 sm:max-w-sm">
              <Label htmlFor="g-name">Name</Label>
              <Input id="g-name" placeholder="Default" />
              <Input placeholder="Disabled" disabled />
              <Input placeholder="Invalid" aria-invalid="true" />
              <Textarea placeholder="Textarea" />
            </div>
          </Section>

          <Section id="g-card" title="Card">
            <Card className="w-72">
              <CardHeader>
                <CardTitle>GEOG 250</CardTitle>
                <CardDescription>Introductory geography</CardDescription>
              </CardHeader>
              <CardContent className="text-caption text-muted-foreground">
                Card body content.
              </CardContent>
              <CardFooter>
                <Button size="sm">Open</Button>
              </CardFooter>
            </Card>
          </Section>

          <Section id="g-table" title="Table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Concept</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>Week 1</TableCell>
                  <TableCell>Maps</TableCell>
                  <TableCell><Badge variant="success">Complete</Badge></TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>Week 2</TableCell>
                  <TableCell>Climate</TableCell>
                  <TableCell><Badge variant="info">In progress</Badge></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </Section>

          <Section id="g-misc" title="Separator · Avatar · Progress · Skeleton">
            <div className="flex items-center gap-4">
              <Avatar>
                <AvatarFallback>AB</AvatarFallback>
              </Avatar>
              <Separator orientation="vertical" className="h-8" />
              <div className="w-40">
                <Progress value={60} />
              </div>
              <Skeleton className="h-8 w-24" />
            </div>
          </Section>

          <Section id="g-overlays" title="Overlays — Dialog · Sheet · Popover · Dropdown · Tooltip">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Open dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Confirm action</DialogTitle>
                  <DialogDescription>This is a dialog rendered from the primitive.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="ghost">Cancel</Button>
                  </DialogClose>
                  <Button>Confirm</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">Open sheet</Button>
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle>Side panel</SheetTitle>
                </SheetHeader>
                <p className="text-caption text-muted-foreground">Drawer content.</p>
              </SheetContent>
            </Sheet>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">Open popover</Button>
              </PopoverTrigger>
              <PopoverContent>Popover body content.</PopoverContent>
            </Popover>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Actions">
                  <Icon icon={MdMoreVert} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Actions</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem>Edit</DropdownMenuItem>
                <DropdownMenuItem>Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost">Hover me</Button>
              </TooltipTrigger>
              <TooltipContent>Tooltip text</TooltipContent>
            </Tooltip>
          </Section>

          <Section id="g-controls" title="Form controls — Select · Checkbox · Radio · Toggle">
            <Select defaultValue="claude">
              <SelectTrigger aria-label="Model" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude Sonnet 4.5</SelectItem>
                <SelectItem value="llama">Llama 3 70B</SelectItem>
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-caption">
              <Checkbox aria-label="Agree" /> Checkbox
            </label>
            <RadioGroup defaultValue="a" className="flex gap-4">
              <label className="flex items-center gap-2 text-caption">
                <RadioGroupItem value="a" aria-label="A" /> A
              </label>
              <label className="flex items-center gap-2 text-caption">
                <RadioGroupItem value="b" aria-label="B" /> B
              </label>
            </RadioGroup>
            <label className="flex items-center gap-2 text-caption">
              <Toggle aria-label="Enabled" /> Toggle
            </label>
          </Section>

          <Section id="g-disclosure" title="Tabs · Accordion · ScrollArea · Command">
            <div className="w-full">
              <Tabs defaultValue="one">
                <TabsList>
                  <TabsTrigger value="one">Tab one</TabsTrigger>
                  <TabsTrigger value="two">Tab two</TabsTrigger>
                </TabsList>
                <TabsContent value="one" className="text-caption text-muted-foreground">
                  First panel.
                </TabsContent>
                <TabsContent value="two" className="text-caption text-muted-foreground">
                  Second panel.
                </TabsContent>
              </Tabs>
            </div>
            <div className="w-full sm:max-w-md">
              <Accordion type="single" collapsible defaultValue="c1">
                <AccordionItem value="c1">
                  <AccordionTrigger>Concept 1</AccordionTrigger>
                  <AccordionContent>Modules under concept 1.</AccordionContent>
                </AccordionItem>
                <AccordionItem value="c2">
                  <AccordionTrigger>Concept 2</AccordionTrigger>
                  <AccordionContent>Modules under concept 2.</AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
            <ScrollArea className="h-24 w-48 rounded-md border border-border p-2">
              <div className="flex flex-col gap-1 text-caption">
                {Array.from({ length: 12 }, (_, i) => (
                  <span key={i}>Row {i + 1}</span>
                ))}
              </div>
            </ScrollArea>
            <div className="w-64 rounded-md border border-border">
              <Command label="Course search">
                <CommandInput placeholder="Search courses" />
                <CommandList>
                  <CommandEmpty>No results.</CommandEmpty>
                  <CommandGroup>
                    <CommandItem>GEOG 250</CommandItem>
                    <CommandItem>URST 200</CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </div>
          </Section>

          <h2 className="text-h4 border-b border-border pb-2 pt-4 text-navy">Composed components</h2>

          <Section id="g-pageheader" title="PageHeader · Breadcrumb · BackButton">
            <div className="flex w-full flex-col gap-4">
              <Breadcrumb
                items={[
                  { label: "Courses", to: "/gallery" },
                  { label: "GEOG 250", to: "/gallery" },
                  { label: "Week 1" },
                ]}
              />
              <PageHeader
                title="Courses"
                description="Everything you're enrolled in."
                actions={<Button size="sm">Join course</Button>}
              />
              <BackButton onClick={() => {}} />
            </div>
          </Section>

          <Section id="g-emptystate" title="EmptyState">
            <EmptyState
              icon={MdInbox}
              title="No courses yet"
              description="Join a course with an access code to get started."
              action={<Button size="sm">Join course</Button>}
            />
          </Section>

          <Section id="g-display" title="StatCard · Tag · FileRow · ListRow">
            <StatCard label="Messages" value={128} trend="+12 this week" />
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Tag label="Photosynthesis" />
                <Tag label="Cell biology" onRemove={() => {}} />
              </div>
              <FileRow file={{ file_id: "f1", file_name: "syllabus.pdf" }} onDelete={() => {}} />
              <ListRow onClick={() => {}} selected>
                Selected row
              </ListRow>
              <ListRow onClick={() => {}}>Default row</ListRow>
            </div>
          </Section>

          <Section id="g-course-people" title="CourseCard · StudentRow · ProfileHeader">
            <CourseCard course={COURSE} onOpen={() => {}} />
            <CourseCard course={COURSE} state="inactive" />
            <div className="flex w-full max-w-md flex-col gap-3">
              <StudentRow
                student={{ first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" }}
                actions={<Button size="sm" variant="ghost">Remove</Button>}
              />
              <ProfileHeader user={{ name: "Dr. Smith" }} subtitle="Instructor · 3 courses" />
            </div>
          </Section>

          <Section id="g-data-forms" title="DataTable · FormField · Searchbar · Model dropdown · ConfirmDialog">
            <div className="w-full">
              <DataTable columns={TABLE_COLUMNS} data={TABLE_DATA} />
            </div>
            <div className="flex w-full max-w-sm flex-col gap-4">
              <FormField label="Course name" hint="Shown to students">
                <Input placeholder="e.g. GEOG 250" />
              </FormField>
              <FormField label="Access code" error="This code is required">
                <Input placeholder="Enter code" />
              </FormField>
              <Searchbar placeholder="Search courses" onChange={() => {}} />
              <LanguageModelDropdown
                aria-label="Language model"
                value="a"
                models={[
                  { id: "a", name: "Claude Sonnet 4.5" },
                  { id: "b", name: "Llama 3 70B" },
                ]}
              />
              <Button variant="danger" onClick={() => setConfirmOpen(true)}>
                Delete course…
              </Button>
              <ConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title="Delete course?"
                description="This permanently removes the course and its modules."
                confirmLabel="Delete"
                onConfirm={() => setConfirmOpen(false)}
              />
            </div>
          </Section>
        </div>
      </main>
    </TooltipProvider>
  )
}
